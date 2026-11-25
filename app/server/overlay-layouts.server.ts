import type { AppEnv } from "../env";
import { STORED_LAYERS_LENGTH, onAnyOutput, storedLayersText } from "../lib/overlay-layers";
import {
  LayoutError,
  STORED_LAYOUTS_LENGTH,
  createLayout,
  deleteLayout,
  parseStoredLayouts,
  renameLayout,
  resetLayout,
  selectLayout,
  storedLayoutsText,
  type LayoutAction,
  type LayoutProblem,
  type LayoutState,
  type NewLayout,
  type OverlayLayouts,
} from "../lib/overlay-layouts";
import type { OverlayState } from "../types";
import { assertStreamerWritable } from "./access.server";
import { HttpError } from "./http.server";
import { OVERLAY_COLUMNS, overlayValue, type OverlayRow } from "./overlay-state";

// The layouts of the overlay: `POST /api/overlay/layouts`. The rules are in app/lib/overlay-layouts.ts. A layout
// action changes the layers and the layouts in one write, so OBS never shows a layout that the list does not have.

/** The error for a layout action that the rules refuse. */
function problemError(problem: LayoutProblem): HttpError {
  if (problem === "unknown") return new HttpError(404, "That layout does not exist.");
  if (problem === "limit")
    return new HttpError(400, "You have the largest number of saved layouts. Delete one first.", "layout_limit");
  if (problem === "active") return new HttpError(400, "This layout is on stream. Select a different layout first.");
  if (problem === "preset") return new HttpError(400, "A preset keeps its name.");
  return new HttpError(400, "The layout on stream is not a preset.");
}

/** The saved layouts of a page. A page without saved state has none. */
export async function getLayouts(env: AppEnv, streamerId: string): Promise<OverlayLayouts> {
  const row = await env.DB.prepare("SELECT layouts FROM overlay_state WHERE streamer_id=?")
    .bind(streamerId)
    .first<{ layouts: string }>();
  return parseStoredLayouts(row?.layouts ?? "{}");
}

/** The state after a layout action. A new layout gets a random ID. */
export function nextLayoutState(state: LayoutState, action: LayoutAction): LayoutState {
  const fresh = (name: string): NewLayout => ({ id: crypto.randomUUID(), name });
  try {
    if (action.action === "select") return selectLayout(state, action.output, action.id, fresh(action.keep));
    if (action.action === "create")
      return createLayout(state, action.output, fresh(action.name), action.from, fresh(action.keep));
    if (action.action === "reset") return resetLayout(state, action.output);
    const layouts: OverlayLayouts =
      action.action === "rename"
        ? renameLayout(state.layouts, action.output, action.id, action.name)
        : deleteLayout(state.layouts, action.output, action.id);
    return { layouts, layers: state.layers };
  } catch (error: unknown) {
    if (error instanceof LayoutError) throw problemError(error.problem);
    throw error;
  }
}

/** The result of `updateLayouts`. `layersChanged` is false for a new name and for a deleted layout. */
export interface LayoutUpdate {
  overlay: OverlayState;
  layouts: OverlayLayouts;
  layersChanged: boolean;
}

// Retry limit for a save that meets a save of another tab.
const WRITE_ATTEMPTS = 3;

// Compare-and-set the revision, as `updateOverlay` does. The layers and the layouts change in one statement.
export async function updateLayouts(
  env: AppEnv,
  userId: string,
  streamerId: string,
  action: LayoutAction,
): Promise<LayoutUpdate> {
  const page = await assertStreamerWritable(env, streamerId, userId);
  if (page.ownerId !== userId) throw new HttpError(403, "Only the streamer can control the overlay.");
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    const row = await env.DB.prepare(`SELECT ${OVERLAY_COLUMNS},layouts FROM overlay_state WHERE streamer_id=?`)
      .bind(streamerId)
      .first<OverlayRow & { layouts: string }>();
    const current: OverlayState = overlayValue(row);
    const before: LayoutState = { layouts: parseStoredLayouts(row?.layouts ?? "{}"), layers: current.layers };
    const after: LayoutState = nextLayoutState(before, action);
    const layersText: string = storedLayersText(after.layers);
    const layoutsText: string = storedLayoutsText(after.layouts);
    if (layersText.length > STORED_LAYERS_LENGTH || layoutsText.length > STORED_LAYOUTS_LENGTH)
      throw new HttpError(400, "The layouts are too large to save. Delete a layout.");
    const next: OverlayState = {
      ...current,
      layers: after.layers,
      // The test plays in the chat layer, so a layout without the chat also ends a running test.
      chatTestUntil: onAnyOutput(after.layers, "chat") ? current.chatTestUntil : 0,
      revision: current.revision + 1,
    };
    const result =
      await env.DB.prepare(`INSERT INTO overlay_state (streamer_id,layers,layouts,chat_test_until,revision,updated_at)
        VALUES (?,?,?,?,?,?)
      ON CONFLICT(streamer_id) DO UPDATE SET layers=excluded.layers,layouts=excluded.layouts,
        chat_test_until=excluded.chat_test_until,revision=excluded.revision,updated_at=excluded.updated_at
      WHERE overlay_state.revision=?`)
        .bind(streamerId, layersText, layoutsText, next.chatTestUntil, next.revision, Date.now(), current.revision)
        .run();
    if (result.meta.changes > 0)
      return { overlay: next, layouts: after.layouts, layersChanged: after.layers !== before.layers };
  }
  throw new HttpError(409, "The overlay changed in another tab. Try again.");
}
