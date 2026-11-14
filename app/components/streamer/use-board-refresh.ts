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
export function usePendingTopic(entries: Entry[], selected: Entry | null): {
  selected: Entry | null;
  hasSelection: boolean;
} {
  const here = useLocation();
  const navigation = useNavigation();
  if (navigation.state === "loading" && navigation.location.pathname === here.pathname) {
    const id: string | null = new URLSearchParams(navigation.location.search).get("entry");
    const pending: Entry | undefined = entries.find((entry: Entry) => entry.id === id);
    if (pending?.kind === "topic") return { selected: pending, hasSelection: true };
  }
  return { selected, hasSelection: new URLSearchParams(here.search).has("entry") };
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
  const refresh = useCallback(async (): Promise<void> => {
    if (active.current !== source) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(source);
    const params = new URLSearchParams({
      kind: source.view === "polls" ? "polls" : "topics",
      sort: source.sort,
      query: source.query,
    });
    if (source.status) params.set("status", source.status);
    try {
      const [board, detail] = await Promise.all([
        requestJson<BoardSnapshot>(`/api/streamers/${encodeURIComponent(source.board.streamer.handle)}?${params}`, {
          signal: controller.signal,
        }),
        source.selected
          ? requestJson<{ entry: Entry }>(`/api/entries/${source.selected.id}`, { signal: controller.signal })
          : null,
      ]);
      if (!controller.signal.aborted) setUpdated({ source, board, selected: detail?.entry ?? null });
    } catch (error: unknown) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (request.current === controller) setLoading(null);
    }
  }, [source]);
  return {
    board: updated?.source === source ? updated.board : source.board,
    selected: updated?.source === source ? updated.selected : source.selected,
    refreshing: loading === source,
    refresh,
  };
}
