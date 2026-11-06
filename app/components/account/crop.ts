/* Circular crop maths for "Adjust your picture" (item 13). The image covers a square stage of side `stage` at
   zoom 1 and can be zoomed to 4x and panned; the offsets are clamped so the stage is always covered. The
   circle is the stage's inscribed circle, and the square around it is what gets uploaded at 512 x 512. */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const OUTPUT_SIZE = 512;

export interface CropState {
  /** 1 to 4. */
  zoom: number;
  /** Pan in stage pixels: how far the image centre sits right of (and below) the stage centre. */
  x: number;
  y: number;
}

export interface CropGeometry extends CropState {
  /** Displayed image size in stage pixels. */
  width: number;
  height: number;
  /** Source square, in image pixels, that the stage shows. */
  sx: number;
  sy: number;
  side: number;
}

export const initialCrop: CropState = { zoom: 1, x: 0, y: 0 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Where the image sits for `state`, with the pan clamped so no gap shows inside the stage. */
export function cropGeometry(
  stage: number,
  image: { width: number; height: number },
  state: CropState,
): CropGeometry {
  const zoom: number = clampZoom(state.zoom);
  const scale: number = Math.max(stage / image.width, stage / image.height) * zoom;
  const width: number = image.width * scale;
  const height: number = image.height * scale;
  const limitX: number = Math.max(0, (width - stage) / 2);
  const limitY: number = Math.max(0, (height - stage) / 2);
  const x: number = Math.max(-limitX, Math.min(limitX, state.x));
  const y: number = Math.max(-limitY, Math.min(limitY, state.y));
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

/** Zooms about the stage centre: the point under the centre stays put. */
export function zoomTo(state: CropState, zoom: number): CropState {
  const next: number = clampZoom(zoom);
  const ratio: number = next / clampZoom(state.zoom);
  return { zoom: next, x: state.x * ratio, y: state.y * ratio };
}

/** Moves the picture by (dx, dy) stage pixels. Clamping happens in cropGeometry. */
export function panBy(state: CropState, dx: number, dy: number): CropState {
  return { ...state, x: state.x + dx, y: state.y + dy };
}

/** Stores the clamped pan so later moves start from where the picture really is. */
export function settle(stage: number, image: { width: number; height: number }, state: CropState): CropState {
  const g: CropGeometry = cropGeometry(stage, image, state);
  return { zoom: g.zoom, x: g.x, y: g.y };
}
