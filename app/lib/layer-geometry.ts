import {
  DESIGN_H,
  DESIGN_W,
  type CharactersLayer,
  type ChatLayer,
  type LayerRect,
  type LayersPatch,
  type OverlayLayers,
} from "./overlay-layers";

/**
 * Pure helpers for the composition editor (issue #663): rect geometry in the 1920x1080 design space and the
 * field-level patches the editor saves. A patch names only the fields the streamer changed, so a save never writes
 * back a field that another tab changed in the meantime. A rect is one field and is always sent whole.
 */

export type EditableLayer = "chat" | "characters";
export type RectField = keyof LayerRect;
export interface MinSize {
  w: number;
  h: number;
}

/** POST /api/overlay {action: "layers"}: only the changed fields of each layer. */
export interface LayersAction extends LayersPatch {
  action: "layers";
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** Whole design pixels, at least `min`, inside the 1920x1080 frame. A rect that is too wide moves left first. */
export function clampRect(rect: LayerRect, min: MinSize): LayerRect {
  const w: number = clamp(Math.round(rect.w), min.w, DESIGN_W);
  const h: number = clamp(Math.round(rect.h), min.h, DESIGN_H);
  return { x: clamp(Math.round(rect.x), 0, DESIGN_W - w), y: clamp(Math.round(rect.y), 0, DESIGN_H - h), w, h };
}

/** Moves a rect by design pixels and keeps its size. */
export function moveRect(rect: LayerRect, dx: number, dy: number): LayerRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, { w: rect.w, h: rect.h });
}

/** Resizes from the bottom-right corner. The top-left corner stays where it is. */
export function resizeRect(rect: LayerRect, dw: number, dh: number, min: MinSize): LayerRect {
  return {
    x: rect.x,
    y: rect.y,
    w: clamp(Math.round(rect.w + dw), min.w, DESIGN_W - rect.x),
    h: clamp(Math.round(rect.h + dh), min.h, DESIGN_H - rect.y),
  };
}

/** Sets one field from a number input. A size that does not fit moves the layer towards the top-left corner. */
export function setRectField(rect: LayerRect, field: RectField, value: number, min: MinSize): LayerRect {
  return clampRect({ ...rect, [field]: value }, min);
}

export function sameRect(a: LayerRect, b: LayerRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** `layers` with one layer's rect replaced. */
export function withRect(layers: OverlayLayers, layer: EditableLayer, rect: LayerRect): OverlayLayers {
  return layer === "chat"
    ? { ...layers, chat: { ...layers.chat, rect } }
    : { ...layers, characters: { ...layers.characters, rect } };
}

type Value = boolean | LayerRect | undefined;

function same(a: Value, b: Value): boolean {
  if (typeof a === "object" && typeof b === "object") return sameRect(a, b);
  return a === b;
}

function copyChat(chat: Partial<ChatLayer>): Partial<ChatLayer> {
  return chat.rect ? { ...chat, rect: { ...chat.rect } } : { ...chat };
}

function copyCharacters(characters: Partial<CharactersLayer>): Partial<CharactersLayer> {
  return characters.rect ? { ...characters, rect: { ...characters.rect } } : { ...characters };
}

function compact(patch: LayersPatch): LayersPatch {
  const result: LayersPatch = {};
  if (patch.chat && Object.keys(patch.chat).length > 0) result.chat = patch.chat;
  if (patch.characters && Object.keys(patch.characters).length > 0) result.characters = patch.characters;
  return result;
}

/** The fields that differ from `before` to `after`, with their `after` values. */
export function diffLayers(before: OverlayLayers, after: OverlayLayers): LayersPatch {
  const chat: Partial<ChatLayer> = {};
  if (before.chat.enabled !== after.chat.enabled) chat.enabled = after.chat.enabled;
  if (!sameRect(before.chat.rect, after.chat.rect)) chat.rect = { ...after.chat.rect };
  if (before.chat.hideCommands !== after.chat.hideCommands) chat.hideCommands = after.chat.hideCommands;
  const characters: Partial<CharactersLayer> = {};
  if (before.characters.enabled !== after.characters.enabled) characters.enabled = after.characters.enabled;
  if (!sameRect(before.characters.rect, after.characters.rect)) characters.rect = { ...after.characters.rect };
  return compact({ chat, characters });
}

/** Both patches in one. A field in `next` wins. */
export function mergePatches(base: LayersPatch, next: LayersPatch): LayersPatch {
  return compact({
    chat: { ...base.chat, ...next.chat },
    characters: { ...base.characters, ...next.characters },
  });
}

/**
 * `draft` without the fields that still hold the value `sent` saved (or failed to save). A field edited again
 * since then has another value and stays.
 */
export function withoutSent(draft: LayersPatch, sent: LayersPatch): LayersPatch {
  const chat: Partial<ChatLayer> = { ...draft.chat };
  if (same(chat.enabled, sent.chat?.enabled)) delete chat.enabled;
  if (same(chat.rect, sent.chat?.rect)) delete chat.rect;
  if (same(chat.hideCommands, sent.chat?.hideCommands)) delete chat.hideCommands;
  const characters: Partial<CharactersLayer> = { ...draft.characters };
  if (same(characters.enabled, sent.characters?.enabled)) delete characters.enabled;
  if (same(characters.rect, sent.characters?.rect)) delete characters.rect;
  return compact({ chat, characters });
}

export function isEmptyPatch(patch: LayersPatch): boolean {
  return patch.chat === undefined && patch.characters === undefined;
}

/** The request for a patch: only its fields, each rect copied whole. */
export function layersAction(patch: LayersPatch): LayersAction {
  const action: LayersAction = { action: "layers" };
  if (patch.chat) action.chat = copyChat(patch.chat);
  if (patch.characters) action.characters = copyCharacters(patch.characters);
  return action;
}

/** The characters placeholder label needs at least this much free width (design pixels) beside the chat box. */
export const MIN_LABEL_FREE = 640;

/**
 * Where the placeholder label of a layer slot goes, so a box over the slot (the chat) never covers it. `center`
 * when the box does not overlap the slot; else the side of the slot with more free width outside the box, with that
 * width. Null when neither side has MIN_LABEL_FREE: then the label does not show.
 */
export function labelPlace(
  slot: LayerRect,
  cover: LayerRect | null,
): { side: "center" | "start" | "end"; free: number } | null {
  if (cover === null) return { side: "center", free: slot.w };
  const apart: boolean =
    cover.x >= slot.x + slot.w ||
    cover.x + cover.w <= slot.x ||
    cover.y >= slot.y + slot.h ||
    cover.y + cover.h <= slot.y;
  if (apart) return { side: "center", free: slot.w };
  const before: number = Math.max(0, cover.x - slot.x);
  const after: number = Math.max(0, slot.x + slot.w - (cover.x + cover.w));
  const free: number = Math.max(before, after);
  if (free < MIN_LABEL_FREE) return null;
  return { side: after > before ? "end" : "start", free };
}
