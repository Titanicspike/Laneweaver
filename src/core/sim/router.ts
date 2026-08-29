/**
 * Routing as a precomputed potential field.
 *
 * For each destination portal we run one backward Dijkstra over the lane graph and
 * keep `cost[laneId]` — the expected seconds from entering that lane to leaving the
 * network there. Lateral edges (lane changes) are part of the graph, so the same
 * table answers three questions at once: which connector to take, which way to
 * change lanes, and whether staying put can reach the destination at all.
 *
 * Vehicles then never carry a materialised route. They read the gradient each tick,
 * which also means they recover automatically if they end up somewhere unplanned.
 */

import type { Lane, Network } from '../network/types';
import { TurnKind } from '../network/types';

/** Seconds of penalty for taking each kind of movement. */
export const TURN_PENALTY: Record<number, number> = {
  [TurnKind.Straight]: 0,
  [TurnKind.Right]: 3,
  [TurnKind.Left]: 7,
  [TurnKind.UTurn]: 30,
  [TurnKind.Merge]: 0,
  [TurnKind.Diverge]: 0,
};

/** Seconds charged for one discretionary lane change when planning. */
export const LANE_CHANGE_COST = 4;

/**
 * A lateral move only counts as route-preferred when it saves at least this much.
 * Without a real threshold, float noise between two equivalent lanes reads as a
 * reason to change lanes — and then to change back.
 */
export const ROUTE_EPSILON = 0.5;

export interface RouteAdvice {
  /** Successor lane to take at the end of the current one, or -1. */
  successor: number;
  /** Preferred lateral move: -1 right, 0 stay, +1 left. */
  lateral: number;
  /** Staying in this lane cannot reach the destination. */
  mandatory: boolean;
  /** Seconds saved by making the lateral move. */
  benefit: number;
}

function laneCost(lane: Lane): number {
  const speed = Math.max(lane.speedLimit, 2);
  return lane.length / speed + (TURN_PENALTY[lane.turn] ?? 0);
}

/** Binary min-heap over lane ids, keyed by a cost array. */
class Heap {
  private ids: Int32Array;
  private keys: Float64Array;
  private size = 0;

  constructor(capacity: number) {
    this.ids = new Int32Array(capacity + 1);
    this.keys = new Float64Array(capacity + 1);
  }

  /**
   * Dijkstra here reinserts on improvement rather than decreasing a key, so the
   * number of pushes is bounded by the *edges* relaxed, not by the nodes. One lane
   * per node happens to be enough on every graph measured — but an out-of-bounds
   * write to a typed array is silently ignored, so being wrong about that would not
   * throw: it would drop entries, leave `size` counting them, and return route costs
   * that are quietly incorrect. A wrong answer nobody is told about is the one bug
   * class worth spending eight lines to make impossible.
   */
  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    ids.set(this.ids);
    keys.set(this.keys);
    this.ids = ids;
    this.keys = keys;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.size = 0;
  }

  push(id: number, key: number): void {
    if (this.size >= this.ids.length) this.grow();
    let i = this.size++;
    this.ids[i] = id;
    this.keys[i] = key;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): number {
    const top = this.ids[0];
    this.size--;
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size];
      this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < this.size && this.keys[l] < this.keys[best]) best = l;
        if (r < this.size && this.keys[r] < this.keys[best]) best = r;
        if (best === i) break;
        this.swap(best, i);
        i = best;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const id = this.ids[a];
    this.ids[a] = this.ids[b];
    this.ids[b] = id;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

export class Router {
  private readonly tables: (Float64Array | null)[];
  /** Per destination: lanes where simply driving off the end *is* arriving. */
  private readonly terminals: (Uint8Array | null)[];
  private readonly heap: Heap;
  /** lane id -> lanes that can reach it, built once. */
  private readonly incoming: Int32Array[];

  /** `laneCost` for every lane, worked out once: it is read on every edge relaxed. */
  private readonly laneCosts: Float64Array;

  /** Lane -> the portal it is an exit lane of, or -1. For `nearestExit`. */
  private readonly exitPortal: Int32Array;

  private readonly forward: Heap;
  private readonly fwdCost: Float64Array;
  private readonly fwdSeen: Int32Array;
  private readonly fwdDone: Int32Array;
  private fwdGeneration = 0;

  constructor(private readonly net: Network) {
    this.heap = new Heap(net.lanes.length + 1);
    this.laneCosts = new Float64Array(net.lanes.length);
    for (const lane of net.lanes) this.laneCosts[lane.id] = laneCost(lane);
    this.exitPortal = new Int32Array(net.lanes.length).fill(-1);
    for (const portal of net.portals) {
      for (const id of portal.exitLanes) if (this.exitPortal[id] < 0) this.exitPortal[id] = portal.id;
    }
    this.forward = new Heap(net.lanes.length + 1);
    this.fwdCost = new Float64Array(net.lanes.length);
    this.fwdSeen = new Int32Array(net.lanes.length);
    this.fwdDone = new Int32Array(net.lanes.length);
    // Zones continue the portals' id space, so a destination is one number
    // everywhere: in the store, in the spawner, and here.
    const destinations = net.portals.length + net.zones.length;
    this.tables = new Array(destinations).fill(null);
    this.terminals = new Array(destinations).fill(null);
    const counts = new Int32Array(net.lanes.length);
    for (const lane of net.lanes) for (const s of lane.successors) counts[s]++;
    this.incoming = new Array(net.lanes.length);
    for (let i = 0; i < net.lanes.length; i++) this.incoming[i] = new Int32Array(counts[i]);
    const fill = new Int32Array(net.lanes.length);
    for (const lane of net.lanes) {
      for (const s of lane.successors) this.incoming[s][fill[s]++] = lane.id;
    }
  }

  /** Cost-to-destination for every lane, cached per destination (portal or zone). */
  costTo(destId: number): Float64Array {
    const cached = this.tables[destId];
    if (cached) return cached;

    const { lanes } = this.net;
    const cost = new Float64Array(lanes.length).fill(Infinity);
    const terminal = new Uint8Array(lanes.length);
    const settled = new Uint8Array(lanes.length);
    const portal = this.net.portals[destId];
    this.heap.clear();
    // Seeding a portal and seeding a zone differ in what "arriving" means. Driving
    // off the end of an exit lane is arriving at a portal, so the seed is the whole
    // lane's cost. Arriving at a zone is *reaching* one of its streets, so the seed
    // is what it costs to get onto it and no further — otherwise a driver bound for
    // a zone would be charged for the length of every street in it and would route
    // to whichever one happened to be shortest.
    const zone = this.net.zones[destId - this.net.portals.length];
    const seeds = portal ? portal.exitLanes : (zone?.lanes ?? []);
    const whole = !!portal;
    for (const id of seeds) {
      terminal[id] = 1;
      const c = whole ? this.laneCosts[id] : 0;
      if (c < cost[id]) {
        cost[id] = c;
        this.heap.push(id, c);
      }
    }
    this.terminals[destId] = terminal;

    while (this.heap.length) {
      const v = this.heap.pop();
      if (settled[v]) continue;
      settled[v] = 1;
      const base = cost[v];
      const lane = lanes[v];

      // Indexed, and the lateral pair written out. Both of these were `for…of`,
      // which allocates an iterator per settled node — and the lateral one built a
      // two-element array as well. That is two allocations for every one of fifty
      // thousand lanes, on every search, which is the same mistake the sim's hot
      // loops are careful about and this is no less hot: it runs whole-graph.
      const inc = this.incoming[v];
      for (let k = 0; k < inc.length; k++) {
        const u = inc[k];
        const c = base + this.laneCosts[u];
        if (c < cost[u] - 1e-6) {
          cost[u] = c;
          this.heap.push(u, c);
        }
      }
      // Lane changes are edges too: reaching `v` laterally costs a change.
      const lateral = base + LANE_CHANGE_COST;
      const left = lane.left;
      if (left >= 0 && lateral < cost[left] - 1e-6) {
        cost[left] = lateral;
        this.heap.push(left, lateral);
      }
      const right = lane.right;
      if (right >= 0 && lateral < cost[right] - 1e-6) {
        cost[right] = lateral;
        this.heap.push(right, lateral);
      }
    }

    this.tables[destId] = cost;
    return cost;
  }

  /**
   * The nearest portal reachable from `fromLane`, other than `exclude`, or -1.
   *
   * Asked **forwards**, from the driver. The backward form is the same question —
   * "which exit is cheapest from here" — and answering it that way means one
   * whole-graph search *per portal*: on a four-mile import that is 2,549 searches
   * and most of a gigabyte of cost tables, all triggered by the first driver who
   * misses an exit, and it took the tick from 0.6 ms to 46. Forwards, it is one
   * search that stops at the first exit it settles, which on a road network is a few
   * hundred lanes: the whole point of retargeting is that the driver takes the
   * nearest way out, so there is no reason to look at the far side of the map.
   *
   * Generation-stamped scratch, so nothing is allocated or cleared per call.
   */
  nearestExit(fromLane: number, exclude: number): number {
    const lanes = this.net.lanes;
    const gen = ++this.fwdGeneration;
    const cost = this.fwdCost;
    const seen = this.fwdSeen;
    const done = this.fwdDone;
    const heap = this.forward;
    heap.clear();
    cost[fromLane] = 0;
    seen[fromLane] = gen;
    heap.push(fromLane, 0);

    while (heap.length) {
      const v = heap.pop();
      if (done[v] === gen) continue;
      done[v] = gen;
      const here = this.exitPortal[v];
      if (here >= 0 && here !== exclude) return here;

      const base = cost[v];
      const lane = lanes[v];
      const succ = lane.successors;
      for (let k = 0; k < succ.length; k++) {
        const u = succ[k];
        const c = base + this.laneCosts[u];
        if (seen[u] !== gen || c < cost[u] - 1e-6) {
          seen[u] = gen;
          cost[u] = c;
          heap.push(u, c);
        }
      }
      const lateral = base + LANE_CHANGE_COST;
      const left = lane.left;
      if (left >= 0 && (seen[left] !== gen || lateral < cost[left] - 1e-6)) {
        seen[left] = gen;
        cost[left] = lateral;
        heap.push(left, lateral);
      }
      const right = lane.right;
      if (right >= 0 && (seen[right] !== gen || lateral < cost[right] - 1e-6)) {
        seen[right] = gen;
        cost[right] = lateral;
        heap.push(right, lateral);
      }
    }
    return -1;
  }

  /** Whether any lane of `portal`'s entries can reach `dest`. */
  reachable(fromLane: number, dest: number): boolean {
    return Number.isFinite(this.costTo(dest)[fromLane]);
  }

  advise(laneId: number, dest: number, out: RouteAdvice): RouteAdvice {
    const cost = this.costTo(dest);
    const lane = this.net.lanes[laneId];

    let successor = -1;
    let best = Infinity;
    for (const s of lane.successors) {
      const c = cost[s];
      if (c < best - 1e-6 || (Math.abs(c - best) <= 1e-6 && successor >= 0 && s < successor)) {
        best = c;
        successor = s;
      }
    }
    // Driving off the end of an exit lane *is* arriving, so it is not a dead end.
    const terminal = this.terminals[dest];
    const stay = terminal && terminal[laneId]
      ? laneCost(lane)
      : successor >= 0 ? best + laneCost(lane) : Infinity;

    const leftCost = lane.left >= 0 ? cost[lane.left] : Infinity;
    const rightCost = lane.right >= 0 ? cost[lane.right] : Infinity;
    const bestSide = Math.min(leftCost, rightCost);

    let lateral = 0;
    let benefit = 0;
    if (Number.isFinite(bestSide) && bestSide < stay - ROUTE_EPSILON) {
      benefit = Number.isFinite(stay) ? stay - bestSide : 1e6;
      if (leftCost < rightCost) lateral = 1;
      else if (rightCost < leftCost) lateral = -1;
      else lateral = lane.left < lane.right ? 1 : -1; // deterministic tie-break
    }

    out.benefit = benefit;
    out.mandatory = !Number.isFinite(stay) && Number.isFinite(bestSide);
    out.lateral = lateral;
    out.successor = successor;
    return out;
  }

  /**
   * Whether a driver could stay in this lane and still reach `dest` by following
   * it. False for exit-only lanes seen from through traffic, which is why nobody
   * drifts into a deceleration lane they do not want.
   */
  canContinue(laneId: number, dest: number): boolean {
    const cost = this.costTo(dest);
    if (this.isTerminal(laneId, dest)) return true;
    for (const s of this.net.lanes[laneId].successors) {
      if (Number.isFinite(cost[s])) return true;
    }
    return false;
  }

  /** True when leaving the network at the end of this lane means arriving. */
  isTerminal(laneId: number, dest: number): boolean {
    this.costTo(dest);
    const terminal = this.terminals[dest];
    return terminal ? terminal[laneId] === 1 : false;
  }

  /** Drops cached tables; call after a recompile. */
  clear(): void {
    this.tables.fill(null);
    this.terminals.fill(null);
  }
}

export function makeAdvice(): RouteAdvice {
  return { successor: -1, lateral: 0, mandatory: false, benefit: 0 };
}
