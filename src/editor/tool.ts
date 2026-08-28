/**
 * Tool interface shared by every editor mode.
 *
 * Tools never touch the document directly: they build commands and hand them to
 * the store, which is what makes undo work uniformly across all of them.
 */

import type { Camera } from '../render/camera';
import type { Theme } from '../render/theme';
import type { AppStore } from '../app/store';

export interface PointerInfo {
  worldX: number;
  worldY: number;
  screenX: number;
  screenY: number;
  button: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface ToolEnv {
  store: AppStore;
  camera: Camera;
  /** World metres per screen pixel; the natural unit for hit tolerances. */
  scale: number;
  /** The profile chosen in the palette, used by the draw tool. */
  activeProfileId: number;
  /** Grade chosen for new roads: -1 tunnel, 0 ground, +1 bridge. */
  activeGrade: number;
  setActiveGrade(grade: number): void;
  setStatus(text: string): void;
  requestRender(): void;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  readonly cursor: string;
  activate?(env: ToolEnv): void;
  deactivate?(env: ToolEnv): void;
  pointerDown?(p: PointerInfo, env: ToolEnv): void;
  pointerMove?(p: PointerInfo, env: ToolEnv): void;
  pointerUp?(p: PointerInfo, env: ToolEnv): void;
  /** Return true if the key was handled. */
  key?(event: KeyboardEvent, env: ToolEnv): boolean;
  draw?(ctx: CanvasRenderingContext2D, camera: Camera, theme: Theme, env: ToolEnv): void;
}
