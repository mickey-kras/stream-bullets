import { z } from "zod";
import { OVERLAY_MESSAGE_STYLES, OVERLAY_POSITIONS, OVERLAY_SIZES, OVERLAY_SOURCES } from "../../db/enums";
import type { OverlayPublic, OverlaySourceRef, OverlayState } from "../types";

/** An `overlay_state` row as D1 returns it. */
export interface OverlayRow {
  air: string;
  preview: string;
  position: string;
  size: string;
  instant: number;
  show_results: number;
  message: string;
  message_style: string;
  revision: number;
}

export const OVERLAY_COLUMNS = "air,preview,position,size,instant,show_results,message,message_style,revision";

/** The overlay message limit, as the `overlay_state_message_check` constraint sets it. */
export const OVERLAY_MESSAGE_LENGTH = 120;

/** A page with no `overlay_state` row shows Auto: the latest active poll. */
export const DEFAULT_OVERLAY: OverlayState = {
  air: { type: "auto", ref: null },
  preview: { type: "auto", ref: null },
  position: "lower",
  size: "m",
  instant: false,
  showResults: true,
  message: "",
  messageStyle: "info",
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

/** Parses a stored row. Throws on a malformed value so a bad row never reaches a client. */
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
    revision: value.revision,
  };
}

/** What viewers and the OBS page may see: no preview, and no message draft unless it is on air. */
export function overlayPublic(state: OverlayState): OverlayPublic {
  return {
    air: state.air,
    position: state.position,
    size: state.size,
    showResults: state.showResults,
    message: state.air.type === "message" ? state.message : "",
    messageStyle: state.messageStyle,
    revision: state.revision,
  };
}
