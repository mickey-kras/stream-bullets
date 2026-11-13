import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router";
import { t, type MessageId } from "../../i18n";
import { paths } from "../../lib/shell";
import type { Entry, LiveSnapshot, SortOrder, StreamEvent, Viewer } from "../../types";
import type { LiveStatus } from "../live";
import { EmptyState } from "../common";
import { MashCard } from "../mash/mash-card";
import { useMashView } from "../mash/use-mash";
import { MashTeaser, PollCard } from "../poll";
import { Icon } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { EntryActions } from "./entry-detail";
import { LiveStrip } from "./topic-board";

const liveLabels: Record<LiveStatus, MessageId> = {
  live: "live.connected",
  connecting: "live.connecting",
  reconnecting: "live.reconnecting",
  offline: "live.offline",
};

// Stable placeholder preserves unconditional hook order.
const NO_BATTLE: Pick<Entry, "id" | "mash"> = { id: "", mash: null };

export interface PollsViewProps {
  name: string;
  viewer: Viewer | null;
  owner: boolean;
  moderator: boolean;
  writable: boolean;
  entries: Entry[];
  // Opened ?entry= poll; null shows the list.
  selected: Entry | null;
  now: number;
  sort: SortOrder;
  liveEvent: StreamEvent | null;
  live: { status: LiveStatus; snapshot: LiveSnapshot | null; reconnect: () => void };
  pending: ReadonlySet<string>;
  more: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  refreshes: number;
  onCreate: () => void;
  onOpen: (id: string | null) => void;
  onSort: (sort: SortOrder) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
  onAction: (body: unknown, id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onDeleteSelected: () => Promise<void>;
  discussion: (entry: Entry) => ReactNode;
}

// Eligible target for Next live poll.
function isOpenPoll(entry: Entry, now: number): boolean {
  return entry.kind !== "mash" && !entry.revealed && (entry.endsAt === null || entry.endsAt > now);
}

// Focus phone layouts on countdown/live battles.
function useBattleFocus(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    document.body.classList.add("battle-focus");
    return () => document.body.classList.remove("battle-focus");
  }, [on]);
}

function PollToolbarStart({
  props,
  battle,
  phase,
}: Readonly<{
  props: Readonly<PollsViewProps>;
  battle: Entry | null;
  phase: string;
}>): ReactNode {
  const { selected, entries, now } = props;
  let toolbarStart: ReactNode = null;
  if (selected && battle && phase === "finished") {
    const next: Entry | undefined = entries.find((entry: Entry) => isOpenPoll(entry, now));
    toolbarStart = (
      <span className="mash-next">
        <button type="button" className="gold back" onClick={() => props.onOpen(null)}>
          <Icon name="chevron-left" size={18} />
          {t("polls.backToPolls")}
        </button>
        {next && (
          <Link className="button-link" to={`?view=polls&entry=${next.id}`}>
            <Icon name="polls" size={18} />
            <span>{t("polls.nextLive", { title: next.title })}</span>
          </Link>
        )}
      </span>
    );
  } else if (selected)
    toolbarStart = (
      <button type="button" className="back" onClick={() => props.onOpen(null)}>
        <Icon name="chevron-left" size={16} />
        {t("polls.all")}
      </button>
    );
  else if (entries.length > 0)
    toolbarStart = (
      <fieldset className="tabs sort-switch">
        <legend className="sr-only">{t("polls.sorting")}</legend>
        {(["newest", "top"] as const).map((value: SortOrder) => (
          <button
            key={value}
            type="button"
            aria-pressed={props.sort === value}
            className={props.sort === value ? "active" : ""}
            onClick={() => props.onSort(value)}
          >
            {value === "newest" ? t("polls.newest") : t("entry.sortTop")}
          </button>
        ))}
      </fieldset>
    );
  return toolbarStart;
}

// Returning to the list restores focus to the poll because its Back control disappears.
function useReturnFocus(selectedId: string | null): void {
  const previous = useRef<string | null>(selectedId);
  useEffect(() => {
    const id: string | null = previous.current;
    previous.current = selectedId;
    if (!id || selectedId) return;
    const active: Element | null = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
    const card: HTMLElement | null = document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
    const target: HTMLElement | null = card?.matches("a") ? card : (card?.querySelector(".discuss-link") ?? null);
    target?.focus();
  }, [selectedId]);
}

// Polls shows the list, a discussion, or a Mash Battle.
export function PollsView(props: Readonly<PollsViewProps>): ReactNode {
  const { name, viewer, owner, writable, entries, selected, now, live } = props;
  useReturnFocus(selected?.id ?? null);
  const battle: Entry | null = selected?.kind === "mash" ? selected : null;
  const phase: string = useBattlePhase(battle, now);
  useBattleFocus(battle !== null && (phase === "live" || phase === "countdown"));
  const offline: boolean = live.status === "offline";
  const card = (entry: Entry): ReactNode =>
    entry.kind === "mash" && !selected ? (
      <MashTeaser key={entry.id} entry={entry} now={now} />
    ) : (
      <PollCard
        key={entry.id}
        entry={entry}
        now={now}
        signedIn={Boolean(viewer) && writable}
        owner={owner && writable}
        pending={props.pending.has(entry.id)}
        onAction={(body: unknown) => props.onAction(body, entry.id)}
        onDiscuss={() => props.onOpen(entry.id)}
        onDelete={() => props.onDelete(entry.id)}
      />
    );
  let body: ReactNode = (selected ? [selected] : entries).map(card);
  if (battle)
    body = (
      <MashCard
        entry={battle}
        now={now}
        signedIn={Boolean(viewer) && writable}
        owner={owner && writable}
        pending={props.pending.has(battle.id)}
        onAction={(body: unknown) => props.onAction(body, battle.id)}
      />
    );
  else if (!selected && entries.length === 0)
    body = owner ? (
      <EmptyState
        title={t("polls.emptyTitle")}
        icon="mic"
        action={
          writable && (
            <button className="gold" type="button" onClick={props.onCreate}>
              <Icon name="plus" size={18} />
              {t("polls.createFirst")}
            </button>
          )
        }
      >
        {t("polls.emptyBody")}
      </EmptyState>
    ) : (
      <EmptyState title={t("polls.viewerEmptyTitle")} icon="mic">
        {t("polls.viewerEmptyBody", { name: name.split(" ")[0] ?? name })}
      </EmptyState>
    );
  return (
    <>
      <LiveStrip event={props.liveEvent} />
      <div className="page-title">
        <div>
          <span className="eyebrow">{t("polls.eyebrow")}</span>
          <h1>
            <span className="sr-only">{name}: </span>
            {t("polls.title")}
          </h1>
          {!battle && <p>{t("polls.lead")}</p>}
        </div>
        {owner && writable && !battle && (
          <button className="gold" type="button" onClick={props.onCreate}>
            <Icon name="plus" size={18} />
            {t("polls.create")}
          </button>
        )}
      </div>
      {(!battle || live.status !== "live") && (
        <div className="connection-status">
          <output className={offline ? "conn-off" : undefined}>
            <Icon name={live.status === "live" ? "wifi" : "wifi-off"} size={16} />
            {t(liveLabels[live.status])}
          </output>
          {offline && (
            <button type="button" onClick={live.reconnect}>
              <Icon name="refresh" size={16} />
              {t("live.reconnect")}
            </button>
          )}
          {!battle && (
            <IconButton
              label={t("polls.refresh")}
              icon="refresh"
              spin={props.refreshes}
              disabled={props.refreshing}
              onClick={props.onRefresh}
            />
          )}
        </div>
      )}
      <div className={`poll-toolbar${selected ? " is-single" : ""}${battle && owner ? " owner-tools" : ""}`}>
        <PollToolbarStart props={props} battle={battle} phase={phase} />
        {owner && (
          <Link className="text-link" to={paths.overlayControl}>
            <Icon name="overlay" size={16} />
            {t("account.overlayControl")}
          </Link>
        )}
      </div>
      {!selected && live.snapshot?.polls.some((poll) => !entries.some((entry: Entry) => entry.id === poll.id)) && (
        <output>
          {t("polls.more")}{" "}
          <button type="button" onClick={props.onRefresh}>
            {t("polls.loadLatest")}
          </button>
        </output>
      )}
      {body}
      {props.more && !selected && (
        <button type="button" className="load-more" disabled={props.loadingMore} onClick={props.onLoadMore}>
          {props.loadingMore ? t("entry.loading") : t("polls.loadMore")}
        </button>
      )}
      {selected && !battle && (
        <div className="poll-card poll-discussion">
          <h2>
            <span className="sr-only">{t("polls.discussionOf")} </span>
            {selected.title}
          </h2>
          <EntryActions
            entry={selected}
            viewer={viewer}
            owner={owner}
            moderator={props.moderator}
            writable={writable}
            pending={props.pending.has(selected.id)}
            onDelete={props.onDeleteSelected}
          />
          {props.discussion(selected)}
        </div>
      )}
    </>
  );
}

function useBattlePhase(battle: Entry | null, now: number): string {
  const view = useMashView(battle ?? NO_BATTLE, now);
  if (!view || view.current === "setup") return "waiting";
  return view.current;
}

// Main layout classes for poll and battle views.
export function usePollsMainClass(selected: Entry | null, now: number): string {
  const battle: Entry | null = selected?.kind === "mash" ? selected : null;
  const phase: string = useBattlePhase(battle, now);
  return battle ? `polls-page mash-page mash-at-${phase}` : "polls-page";
}
