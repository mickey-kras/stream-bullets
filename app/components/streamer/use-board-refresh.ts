import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigation } from "react-router";
import type { BoardSnapshot, Entry, EntryStatus, SortOrder } from "../../types";
import { requestJson } from "../api";
import type { StreamerView } from "../shell/streamer-header";

interface BoardSource {
  board: BoardSnapshot;
  selected: Entry | null;
  view: StreamerView;
  sort: SortOrder;
  query: string;
  status: EntryStatus | null;
}

// Show a loaded topic while the router refreshes its server data. Cancellation restores the current selection.
// The shown topic is provisional until then: the router requested its data before any action on it, so an action
// now would be overwritten by that older data.
export function usePendingTopic(
  entries: Entry[],
  selected: Entry | null,
): {
  selected: Entry | null;
  hasSelection: boolean;
  provisional: boolean;
} {
  const here = useLocation();
  const navigation = useNavigation();
  if (navigation.state === "loading" && navigation.location.pathname === here.pathname) {
    const id: string | null = new URLSearchParams(navigation.location.search).get("entry");
    const pending: Entry | undefined = entries.find((entry: Entry) => entry.id === id);
    if (pending?.kind === "topic") return { selected: pending, hasSelection: true, provisional: true };
  }
  return { selected, hasSelection: new URLSearchParams(here.search).has("entry"), provisional: false };
}

export function useBoardRefresh(source: BoardSource): {
  board: BoardSnapshot;
  selected: Entry | null;
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const [updated, setUpdated] = useState<{
    source: BoardSource;
    board: BoardSnapshot;
    selected: Entry | null;
  } | null>(null);
  const [loading, setLoading] = useState<BoardSource | null>(null);
  const request = useRef<AbortController | null>(null);
  const active = useRef<BoardSource | null>(source);
  useEffect(() => {
    active.current = source;
    return () => {
      active.current = null;
      request.current?.abort();
    };
  }, [source]);
  // Refresh the source that is on screen now. The caller can hold this function from an earlier render, and the
  // router can replace the source while a mutation is in flight.
  const refresh = useCallback(async (): Promise<void> => {
    const current = active.current;
    if (!current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(current);
    const params = new URLSearchParams({
      kind: current.view === "polls" ? "polls" : "topics",
      sort: current.sort,
      query: current.query,
    });
    if (current.status) params.set("status", current.status);
    try {
      const [board, detail] = await Promise.all([
        requestJson<BoardSnapshot>(`/api/streamers/${encodeURIComponent(current.board.streamer.handle)}?${params}`, {
          signal: controller.signal,
        }),
        current.selected
          ? requestJson<{ entry: Entry }>(`/api/entries/${current.selected.id}`, { signal: controller.signal })
          : null,
      ]);
      if (!controller.signal.aborted) setUpdated({ source: current, board, selected: detail?.entry ?? null });
    } catch (error: unknown) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (request.current === controller) setLoading(null);
    }
  }, []);
  return {
    board: updated?.source === source ? updated.board : source.board,
    selected: updated?.source === source ? updated.selected : source.selected,
    refreshing: loading === source,
    refresh,
  };
}
