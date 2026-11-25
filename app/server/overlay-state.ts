import { z } from "zod";
import { OVERLAY_MESSAGE_STYLES, OVERLAY_POSITIONS, OVERLAY_SIZES, OVERLAY_SOURCES } from "../../db/enums";
import { LEGACY_DEFAULT, parseStoredLayers } from "../lib/overlay-legacy";
import { onAnyOutput } from "../lib/overlay-layers";
import type { OverlayPublic, OverlayState } from "../types";

// `air`, `position` and `size` are from before the overlay studio. The server reads them only to convert an old
// `layers` text (app/lib/overlay-legacy.ts) and never writes them.
export interface OverlayRow {
  air: string;
  position: string;
  size: string;
  show_results: number;
  message: string;
  message_style: string;
  layers: string;
  chat_test_until: number;
  revision: number;
}

export const OVERLAY_COLUMNS = "air,position,size,show_results,message,message_style,layers,chat_test_until,revision";

// Match `overlay_state_message_check`.
export const OVERLAY_MESSAGE_LENGTH = 120;

// A page with no `overlay_state` row shows the poll layer with the latest active poll: the old default source.
export const DEFAULT_OVERLAY: OverlayState = {
  showResults: true,
  message: "",
  messageStyle: "info",
  layers: parseStoredLayers("{}", LEGACY_DEFAULT),
  chatTestUntil: 0,
  revision: 0,
};

// SQL for a row of `overlay_state`: true when the content layer `layer` (an SQL value) has a cell in an output. The
// two outputs are on stream at the same time. It does not read `enabled`: one more reload of the overlay does no harm.
export function placedLayerSql(layer: string): string {
  return `(json_type(layers, '$.cells.horizontal.' || ${layer})='object'
    OR json_type(layers, '$.cells.vertical.' || ${layer})='object')`;
}

const sourceSchema = z.object({ type: z.enum(OVERLAY_SOURCES), ref: z.string().min(1).max(64).nullable() }).strict();

const rowSchema = z.object({
  position: z.enum(OVERLAY_POSITIONS),
  size: z.enum(OVERLAY_SIZES),
  show_results: z.union([z.literal(0), z.literal(1)]),
  message: z.string().max(OVERLAY_MESSAGE_LENGTH),
  message_style: z.enum(OVERLAY_MESSAGE_STYLES),
  chat_test_until: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

// Reject malformed stored state before sending it to clients. Invalid layers read as their defaults. An old
// `layers` text reads as its converted layers.
export function overlayValue(row: OverlayRow | null | undefined): OverlayState {
  if (!row) return DEFAULT_OVERLAY;
  const value = rowSchema.parse(row);
  const air = sourceSchema.parse(JSON.parse(row.air));
  return {
    showResults: value.show_results === 1,
    message: value.message,
    messageStyle: value.message_style,
    layers: parseStoredLayers(row.layers, { air, position: value.position, size: value.size }),
    chatTestUntil: value.chat_test_until,
    revision: value.revision,
  };
}

// Public overlay: the message is public only while the message layer is on stream in an output. Otherwise it is a
// draft.
export function overlayPublic(state: OverlayState): OverlayPublic {
  return {
    showResults: state.showResults,
    message: onAnyOutput(state.layers, "message") ? state.message : "",
    messageStyle: state.messageStyle,
    layers: state.layers,
    chatTestUntil: state.chatTestUntil,
    revision: state.revision,
  };
}
