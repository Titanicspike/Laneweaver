/**
 * Palette and level-of-detail thresholds.
 *
 * All widths are in metres unless the name says pixels; the renderer draws in
 * world units so line weights scale with zoom, with a pixel floor so nothing
 * disappears when zoomed out.
 */

export interface Theme {
  background: string;
  grid: string;
  water: string;
  waterEdge: string;
  land: string;
  contour: string;
  cliff: string;

  asphalt: string;
  casing: string;
  junctionFill: string;
  markingWhite: string;
  markingYellow: string;
  markingEdge: string;
  stopBar: string;

  bridgeShadow: string;
  tunnelAlpha: number;

  treeCrown: string;
  treeHighlight: string;
  /**
   * Land-use buildings. Roofs come in a small palette rather than one colour,
   * because from above a street *is* its roofs, and a row of identical grey
   * rectangles reads as a diagram rather than as houses. `buildingLit` is drawn over
   * whichever roof colour is underneath, so one path serves the whole palette.
   */
  roofHouse: string[];
  roofShop: string[];
  /** Cast by every building, in one direction for the whole map. */
  buildingShadow: string;
  buildingEdge: string;
  /**
   * The ground a plot sits on. A garden behind a house is grass; the same ground
   * behind a shop is a service yard with bins and a van on it, and drawing a high
   * street standing on lawn is the single thing that most gives it away.
   */
  plotGround: string;
  plotYard: string;
  plotPaving: string;

  vehicle: string[];
  vehicleOutline: string;
  vehicleBraking: string;

  /** Junction movements, drawn as splines by the inspector. Colour reinforces the
   *  shape rather than replacing it: a left turn visibly curves left. */
  movementStraight: string;
  movementLeft: string;
  movementRight: string;
  movementBlend: string;

  /** Zoning overlay, shown only while the zone tool is in hand. */
  zoneHouses: string;
  zoneShops: string;
  zoneNone: string;

  selection: string;
  preview: string;
  previewBad: string;
  handle: string;
  handleLine: string;
  portal: string;

  errorMark: string;
  warnMark: string;
  infoMark: string;

  signalRed: string;
  signalAmber: string;
  signalGreen: string;

  text: string;
  textDim: string;
  panel: string;
  panelBorder: string;
}

export const DARK: Theme = {
  background: '#14161a',
  grid: '#1c1f24',
  water: '#16303f',
  waterEdge: '#1f4a60',
  land: '#191d1c',
  contour: '#232a28',
  cliff: '#3a3330',

  asphalt: '#33373d',
  casing: '#0e1013',
  junctionFill: '#35393f',
  markingWhite: '#c9cdd4',
  markingYellow: '#d8b13f',
  markingEdge: '#8d939c',
  stopBar: '#dfe3e8',

  bridgeShadow: '#07080a',
  tunnelAlpha: 0.4,

  treeCrown: '#2c4232',
  treeHighlight: '#38553f',
  roofHouse: ['#7a5340', '#5c626c', '#8a5340', '#4e5a50', '#574a3e'],
  roofShop: ['#565c67', '#6a707c', '#47505d', '#5f5a56', '#4e565f'],
  buildingShadow: '#080a0c',
  buildingEdge: '#15181c',
  plotGround: '#1e2921',
  plotYard: '#26282c',
  plotPaving: '#4a4f56',

  vehicle: ['#d8dde5', '#7fb2e5', '#e0a35c', '#8fce8a', '#d67b7b', '#b79ae0', '#5fc7c1'],
  vehicleOutline: '#0d0f12',
  vehicleBraking: '#ff5f56',

  movementStraight: '#59c2ff',
  movementLeft: '#f5c542',
  movementRight: '#4cc76a',
  movementBlend: '#5fc7c1',

  zoneHouses: '#4cc76a',
  zoneShops: '#59a8ff',
  zoneNone: '#6b727c',

  selection: '#f5c542',
  preview: '#59c2ff',
  previewBad: '#ff6b6b',
  handle: '#f5c542',
  handleLine: '#7a6a2c',
  portal: '#59c2ff',

  errorMark: '#ff6b6b',
  warnMark: '#f0b429',
  infoMark: '#59c2ff',

  signalRed: '#e8503f',
  signalAmber: '#f0b429',
  signalGreen: '#4cc76a',

  text: '#e6e9ee',
  textDim: '#8b929c',
  panel: '#1b1e23',
  panelBorder: '#2b3038',
};

/** Zoom (pixels per metre) thresholds that switch detail on and off. */
export const LOD = {
  /** Below this, lane markings are not drawn at all. */
  markings: 0.16,
  /** Below this, junction detail and stop bars are skipped. */
  junctionDetail: 0.5,
  /** Below this, arrows and word markings are skipped: too small to read. */
  symbols: 1.1,
  /** Below this, verge planting is skipped: it would be a green smudge. */
  trees: 0.3,
  /**
   * Buildings survive further out than trees. They are what tells a residential
   * street from an arterial at a glance, and at the zoom where the planting turns
   * to smudge a block of houses still reads as a block of houses.
   */
  buildings: 0.16,
  /**
   * The outline around each roof. Finer than the buildings themselves: below this
   * it is a smear along every wall rather than a line between two houses.
   */
  buildingEdge: 0.5,
  /** Below this, vehicles are drawn as dots rather than bodies. */
  vehicleBodies: 0.55,
  /** Below this, vehicles are not drawn at all. */
  vehicles: 0.12,
  /** Below this, the world grid is hidden. */
  grid: 0.25,
  /** Below this, signal heads are hidden. */
  signals: 0.9,
};

export const WIDTHS = {
  /** Casing width added either side of the asphalt, metres. */
  casing: 0.55,
  laneMarking: 0.14,
  edgeMarking: 0.16,
  doubleGap: 0.34,
  dash: [3.0, 5.0] as [number, number],
  tunnelDash: [6, 4] as [number, number],
  stopBar: 0.5,
  /** Width of one zebra stripe. Wide, because that is what makes it read as one. */
  zebra: 0.62,
  /** Minimum on-screen width for any stroked line, pixels. */
  minPixels: 0.8,
  /** Minimum on-screen length for one dash before the pattern is stretched. */
  minDashPixels: 2.5,
};
