import type { ChatLimits, ChatRow } from "./chat-feed";

/**
 * The removed rows that fade out after the chat reducer drops them (issue #663), as pure functions. The chat layer
 * keeps a dropped removed row on screen for `leaveMs` while its card fades, then the column closes up.
 *
 * Each faded row has its own start time, so a flood of deletes never keeps old faded rows on screen. Faded rows and
 * the reducer's leaving rows share the `maxLeaving` bound: the screen never shows more than maxRows + maxLeaving rows.
 */

export type FadeLimits = Pick<ChatLimits, "leaveMs" | "maxLeaving" | "removedHoldMs">;

/**
 * A removed row that the reducer dropped, with the local time its fade started: the end of its hold, when the
 * reducer drops it. These functions read no clock, so they can run during a render.
 */
export interface GoneRow {
  row: ChatRow;
  goneAt: number;
}

/** A row to render. `gone` marks a fading row; `newest` marks the newest active row (the accent card). */
export interface ShownRow {
  row: ChatRow;
  gone: boolean;
  newest: boolean;
}

/** The faded rows whose fade has not ended at `now`. Returns the same array when none ended. */
export function pruneGone(gone: readonly GoneRow[], now: number, limits: FadeLimits): readonly GoneRow[] {
  const kept: GoneRow[] = gone.filter((item: GoneRow): boolean => now - item.goneAt < limits.leaveMs);
  return kept.length === gone.length ? gone : kept;
}

/**
 * The faded rows after the reducer changed `prevRows` to `rows`: a removed row that `rows` no longer holds starts its
 * fade, and a row that `rows` holds again stops fading. The newest fade start is the latest time known, so the fades
 * that ended before it go (a timer at goneWakeAt removes the others). When more rows fade than the `maxLeaving` bound
 * allows (less the leaving rows of `rows`), the oldest fades end at once. Returns `prevGone` when nothing changes.
 */
export function nextGone(
  prevGone: readonly GoneRow[],
  prevRows: readonly ChatRow[],
  rows: readonly ChatRow[],
  limits: FadeLimits,
): readonly GoneRow[] {
  const ids = new Set<string>(rows.map((row: ChatRow): string => row.id));
  const fading = new Set<string>(prevGone.map((item: GoneRow): string => item.row.id));
  const dropped: GoneRow[] = prevRows
    .filter((row: ChatRow): boolean => row.phase === "removed" && !ids.has(row.id) && !fading.has(row.id))
    .map((row: ChatRow): GoneRow => ({ row, goneAt: row.phaseAt + limits.removedHoldMs }));
  let now: number = Number.NEGATIVE_INFINITY;
  for (const item of dropped) now = Math.max(now, item.goneAt);
  const kept: GoneRow[] = pruneGone(prevGone, now, limits).filter((item: GoneRow): boolean => !ids.has(item.row.id));
  const leaving: number = rows.filter((row: ChatRow): boolean => row.phase === "leaving").length;
  const room: number = Math.max(0, limits.maxLeaving - leaving);
  const all: GoneRow[] = [...kept, ...dropped];
  const next: GoneRow[] = all.length > room ? all.slice(all.length - room) : all;
  const same: boolean =
    next.length === prevGone.length && next.every((item: GoneRow, index: number): boolean => item === prevGone[index]);
  return same ? prevGone : next;
}

/** The local time at which the next fade ends, or null when no row fades. */
export function goneWakeAt(gone: readonly GoneRow[], limits: FadeLimits): number | null {
  if (gone.length === 0) return null;
  return Math.min(...gone.map((item: GoneRow): number => item.goneAt + limits.leaveMs));
}

/**
 * The rows to render, in arrival order: the reducer's rows and the fading rows. The newest row that is entering or
 * shown is `newest`; a removed, leaving or fading row is never `newest`.
 */
export function shownRows(rows: readonly ChatRow[], gone: readonly GoneRow[]): ShownRow[] {
  const shown: ShownRow[] = [
    ...rows.map((row: ChatRow): ShownRow => ({ row, gone: false, newest: false })),
    ...gone.map((item: GoneRow): ShownRow => ({ row: item.row, gone: true, newest: false })),
  ];
  if (gone.length > 0) shown.sort((a: ShownRow, b: ShownRow): number => a.row.seq - b.row.seq);
  for (let index = shown.length - 1; index >= 0; index -= 1) {
    const item: ShownRow = shown[index];
    if (item.gone || (item.row.phase !== "entering" && item.row.phase !== "shown")) continue;
    item.newest = true;
    break;
  }
  return shown;
}
