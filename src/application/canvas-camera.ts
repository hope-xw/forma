import {
  MAX_ZOOM,
  MIN_ZOOM,
  zoomAt,
  type Point,
  type Viewport,
} from "../domain/geometry";

export const WHEEL_ZOOM_PRESETS = [
  0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8, 16, 32, 64,
] as const;

export interface WheelDeltaInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  anchor: Point;
}

export function clampZoom(zoom: number): number {
  return Number.isNaN(zoom) ? 1 : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function applyWheelToViewport(
  current: Viewport,
  input: WheelDeltaInput,
): { viewport: Viewport; kind: "zoom" | "pan" } {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? 400 : 1;
  const dx = input.deltaX * unit,
    dy = input.deltaY * unit;
  if (input.ctrlKey || input.metaKey) {
    // The entire pinch range (|dy| <= 40) lies inside these damping limits.
    const factor = Math.max(0.65, Math.min(1.54, Math.exp(-dy * 0.01)));
    const zoom = clampZoom(current.zoom * factor);
    return {
      viewport:
        zoom === current.zoom ? current : zoomAt(current, zoom, input.anchor),
      kind: "zoom",
    };
  }
  const horizontal = input.shiftKey && Math.abs(dx) < Math.abs(dy);
  return {
    viewport: {
      x: current.x - (horizontal ? dy : dx),
      y: current.y - (horizontal ? 0 : dy),
      zoom: current.zoom,
    },
    kind: "pan",
  };
}

export function stepZoomLevel(currentZoom: number, direction: 1 | -1): number {
  const zoom = clampZoom(currentZoom);
  if (direction === 1)
    return WHEEL_ZOOM_PRESETS.find((level) => level > zoom) ?? MAX_ZOOM;
  for (let i = WHEEL_ZOOM_PRESETS.length - 1; i >= 0; i--) {
    if (WHEEL_ZOOM_PRESETS[i] < zoom) return WHEEL_ZOOM_PRESETS[i];
  }
  return MIN_ZOOM;
}

export interface CameraState {
  viewport: Viewport;
  interacting: boolean;
}
export interface CameraChannel {
  get(): Viewport;
  isInteracting(): boolean;
  setLive(next: Viewport): void;
  setImmediate(next: Viewport): void;
  flush(): void;
  subscribeLive(listener: (state: CameraState) => void): () => void;
  subscribeSettled(listener: (viewport: Viewport) => void): () => void;
  dispose(): void;
}
type TimerHandle = number | ReturnType<typeof setTimeout>;
interface CameraOptions {
  settleMs?: number;
  scheduleTimeout?(callback: () => void, ms: number): TimerHandle;
  clearTimeout?(timer: TimerHandle): void;
}
export function createCameraChannel(
  initial: Viewport,
  options: CameraOptions = {},
): CameraChannel {
  let state: CameraState = { viewport: initial, interacting: false };
  let timer: TimerHandle | undefined;
  let disposed = false;
  const live = new Set<(state: CameraState) => void>();
  const settled = new Set<(viewport: Viewport) => void>();
  const {
    settleMs = 72,
    scheduleTimeout = setTimeout,
    clearTimeout: cancel = clearTimeout,
  } = options;
  function cancelTimer() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  }
  function publish(next: CameraState) {
    state = next;
    for (const listener of live) {
      if (state !== next) return; // A listener issued a newer camera update.
      listener(next);
    }
    if (!next.interacting) {
      for (const listener of settled) {
        if (state !== next) return;
        listener(next.viewport);
      }
    }
  }
  function flush() {
    if (!state.interacting || disposed) return;
    cancelTimer();
    publish({ viewport: state.viewport, interacting: false });
  }
  return {
    get: () => state.viewport,
    isInteracting: () => state.interacting,
    setLive(next) {
      if (disposed) return;
      cancelTimer();
      timer = scheduleTimeout(flush, settleMs);
      publish({ viewport: next, interacting: true });
    },
    setImmediate(next) {
      if (disposed) return;
      cancelTimer();
      publish({ viewport: next, interacting: false });
    },
    flush,
    subscribeLive(listener) {
      if (!disposed) live.add(listener);
      return () => live.delete(listener);
    },
    subscribeSettled(listener) {
      if (!disposed) settled.add(listener);
      return () => settled.delete(listener);
    },
    dispose() {
      disposed = true;
      cancelTimer();
      live.clear();
      settled.clear();
      state = { viewport: state.viewport, interacting: false };
    },
  };
}

// The camera and minimap UI share one world-to-map projection.
export {
  computeMinimapLayout,
  minimapPointToViewport,
  worldRectToMinimap,
  type MinimapLayout,
} from "./minimap-layout";
