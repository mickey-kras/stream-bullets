import { z } from "zod";
import { OVERLAY_MESSAGE_STYLES, OVERLAY_POSITIONS, OVERLAY_SIZES, OVERLAY_SOURCES } from "../../db/enums";
import { DEFAULT_LAYERS, parseStoredLayers } from "../lib/overlay-layers";
import type { OverlayPublic, OverlaySourceRef, OverlayState } from "../types";

export interface OverlayRow {
  air: string;
  preview: string;
  position: string;
  size: string;
  instant: number;
  show_results: number;
  message: string;
  message_style: string;
  layers: string;
  revision: number;
}

export const OVERLAY_COLUMNS = "air,preview,position,size,instant,show_results,message,message_style,layers,revision";

// Match `overlay_state_message_check`.
export const OVERLAY_MESSAGE_LENGTH = 120;

// A page with no `overlay_state` row shows Auto: the latest active poll.
export const DEFAULT_OVERLAY: OverlayState = {
  air: { type: "auto", ref: null },
  preview: { type: "auto", ref: null },
  position: "lower",
  size: "m",
  instant: false,
  showResults: true,
  message: "",
  messageStyle: "info",
  layers: DEFAULT_LAYERS,
  revision: 0,
};

export const overlaySourceSchema = z
  .object({ type: z.enum(OVERLAY_SOURCES), ref: z.string().min(1).max(64).nullable() })
  .strict();

const rowSchema = z.object({
  position: z.enum(OVERLAY_POSITIONS),
  size: z.enum(OVERLAY_SIZES),
  instant: z.union([z.literal(0), z.literal(1)]),
  show_results: z.union([z.literal(0), z.literal(1)]),
  message: z.string().max(OVERLAY_MESSAGE_LENGTH),
  message_style: z.enum(OVERLAY_MESSAGE_STYLES),
  revision: z.number().int().nonnegative(),
});

function source(raw: string): OverlaySourceRef {
  return overlaySourceSchema.parse(JSON.parse(raw));
}

// Reject malformed stored state before sending it to clients. Invalid layers read as their defaults.
export function overlayValue(row: OverlayRow | null | undefined): OverlayState {
  if (!row) return DEFAULT_OVERLAY;
  const value = rowSchema.parse(row);
  return {
    air: source(row.air),
    preview: source(row.preview),
    position: value.position,
    size: value.size,
    instant: value.instant === 1,
    showResults: value.show_results === 1,
    message: value.message,
    messageStyle: value.message_style,
    layers: parseStoredLayers(row.layers),
    revision: value.revision,
  };
}

// Public overlay: exclude preview and unaired message drafts.
export function overlayPublic(state: OverlayState): OverlayPublic {
  return {
    air: state.air,
    position: state.position,
    size: state.size,
    showResults: state.showResults,
    message: state.air.type === "message" ? state.message : "",
    messageStyle: state.messageStyle,
    layers: state.layers,
    revision: state.revision,
  };
}
