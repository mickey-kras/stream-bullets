// Clamp pan to cover the square stage at 1x..4x zoom. The inscribed circle previews a 512x512 square upload.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const OUTPUT_SIZE = 512;

export interface CropState {
  // 1..4.
  zoom: number;
  // Pan in stage pixels, positive right/down from center.
  x: number;
  y: number;
}

export interface CropGeometry extends CropState {
  width: number;
  height: number;
  // Visible source square in image pixels.
  sx: number;
  sy: number;
  side: number;
}

export const initialCrop: CropState = { zoom: 1, x: 0, y: 0 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// Clamp pan to keep the stage covered.
export function cropGeometry(stage: number, image: { width: number; height: number }, state: CropState): CropGeometry {
  const zoom: number = clampZoom(state.zoom);
  const scale: number = Math.max(stage / image.width, stage / image.height) * zoom;
  const width: number = image.width * scale;
  const height: number = image.height * scale;
  const limitX: number = Math.max(0, (width - stage) / 2);
  const limitY: number = Math.max(0, (height - stage) / 2);
  // Normalize clamped -0 to 0.
  const x: number = Math.max(-limitX, Math.min(limitX, state.x)) || 0;
  const y: number = Math.max(-limitY, Math.min(limitY, state.y)) || 0;
  const side: number = stage / scale;
  return {
    zoom,
    x,
    y,
    width,
    height,
    side,
    sx: image.width / 2 - x / scale - side / 2,
    sy: image.height / 2 - y / scale - side / 2,
  };
}

// Keep the point under stage center fixed while zooming.
export function zoomTo(state: CropState, zoom: number): CropState {
  const next: number = clampZoom(zoom);
  const ratio: number = next / clampZoom(state.zoom);
  return { zoom: next, x: state.x * ratio, y: state.y * ratio };
}

// Pan in stage pixels; cropGeometry clamps it.
export function panBy(state: CropState, dx: number, dy: number): CropState {
  return { ...state, x: state.x + dx, y: state.y + dy };
}

// Persist clamped pan so later moves start at the visible position.
export function settle(stage: number, image: { width: number; height: number }, state: CropState): CropState {
  const g: CropGeometry = cropGeometry(stage, image, state);
  return { zoom: g.zoom, x: g.x, y: g.y };
}
