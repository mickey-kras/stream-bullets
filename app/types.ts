import type { Locale } from "./i18n";
import type {
  CARD_ICONS,
  CARD_TABS,
  ENTRY_STATUSES,
  MASH_PHASES,
  MODERATION_TARGETS,
  OVERLAY_MESSAGE_STYLES,
  OVERLAY_POSITIONS,
  OVERLAY_SIZES,
  OVERLAY_SOURCES,
  STREAM_EVENT_STATUSES,
  STREAM_PLATFORMS,
  STREAMER_STATUSES,
  SUPPORT_LINK_KINDS,
} from "../db/enums";

/** Sign-in providers, in the order the sign-in dialog lists them. */
export type Provider = "google" | "tiktok" | "twitch" | "instagram";

/** `mash` is a `choice` entry with an `entry_mash` row (R1). The API reports it as its own kind. */
export type EntryKind = "topic" | "choice" | "binary" | "mash";
export type SortOrder = "newest" | "top";
export type Reaction = -1 | 0 | 1;

export type StreamerStatus = (typeof STREAMER_STATUSES)[number];
export type EntryStatus = (typeof ENTRY_STATUSES)[number];
export type StreamPlatform = (typeof STREAM_PLATFORMS)[number];
export type StreamEventStatus = (typeof STREAM_EVENT_STATUSES)[number];
export type CardIcon = (typeof CARD_ICONS)[number];
export type CardTab = (typeof CARD_TABS)[number];
export type SupportLinkKind = (typeof SUPPORT_LINK_KINDS)[number];
export type OverlaySource = (typeof OVERLAY_SOURCES)[number];
export type OverlayPosition = (typeof OVERLAY_POSITIONS)[number];
export type OverlaySize = (typeof OVERLAY_SIZES)[number];
export type OverlayMessageStyle = (typeof OVERLAY_MESSAGE_STYLES)[number];
export type MashPhase = (typeof MASH_PHASES)[number];

/** "Accessibility & display" preferences (item 39). Every key is optional; missing keys use the default. */
export interface DisplayPrefs {
  cvd?: "default" | "pd" | "tri";
  contrast?: "default" | "high";
  motion?: "system" | "reduce" | "full";
  text?: "100" | "115" | "130";
  underline?: boolean;
  font?: "default" | "readable";
  mashAssist?: "off" | "hold" | "toggle";
  srInterval?: "2" | "5" | "10" | "off";
  shortcuts?: boolean;
}

export interface Viewer {
  id: string;
  name: string;
  /** Uploaded picture, or null. */
  avatar: string | null;
  /** Preset 0..17, or null. With no upload and no preset the client shows preset 14 (DEFAULT_AVATAR_PRESET). */
  avatarPreset: number | null;
  /** Saved language, or null to follow the cookie and the browser. */
  locale: Locale | null;
  /** Saved display preferences, or null when the account never saved any. */
  displayPrefs: DisplayPrefs | null;
}

export interface Streamer {
  id: string;
  handle: string;
  name: string;
  about: string;
  /** The owner's uploaded picture, copied to the page. */
  avatar: string | null;
  background: string | null;
  ownerId: string;
  /** Page logo. The client falls back to `avatar`, then `ownerAvatarPreset`, then the default spaceman. */
  logo: string | null;
  /** The owner's preset picture (0..17), part of "the owner's profile picture" when there is no upload. */
  ownerAvatarPreset: number | null;
  /** The official StreamBullets page, pinned first in the directory. */
  isOfficial: boolean;
  /** `frozen` pages are public and read-only. `suspended` pages reach only their owner and admins. */
  status: StreamerStatus;
  /** Why the page is frozen or suspended. Only set for the owner and admins; null for everyone else. */
  statusReason: string | null;
  /** When the page was last frozen or suspended (ms). Only set for the owner and admins; null for everyone else. */
  statusChangedAt: number | null;
  /** Last handle change, for the owner (a handle can change once every 30 days). Null for everyone else. */
  handleChangedAt: number | null;
}

export interface StreamerDirectory {
  streamers: Streamer[];
  nextCursor: string | null;
}

export interface Entry {
  id: string;
  streamerId: string;
  authorId: string;
  author: string;
  avatar: string | null;
  /** The author's preset 0..17, or null (see `Viewer.avatarPreset`). */
  avatarPreset: number | null;
  kind: EntryKind;
  title: string;
  body: string;
  category: string;
  createdAt: number;
  endsAt: number | null;
  revealed: boolean;
  options: string[];
  counts: number[] | null;
  total: number;
  likes: number;
  dislikes: number;
  comments: number;
  reaction: Reaction;
  myVote: number | null;
  /** Ideas board status on the official page; null elsewhere. */
  status: EntryStatus | null;
  /** Shown with `declined` ("Not planned"). */
  statusReason: string | null;
  /** The viewer has an open report on this topic or poll. */
  reported: boolean;
  /** Mash Battle state when `kind` is `mash`, else null. `counts` then holds the players on each side. */
  mash: MashState | null;
}

/** A Mash Battle (item 31). Sides are the entry's `options`; a viewer's side is their vote. */
export interface MashState {
  durationS: number;
  /** As stored. Use `mashPhaseAt()` from app/lib/mash.ts for the phase at a given time. */
  phase: MashPhase;
  startsAt: number | null;
  endsAt: number | null;
  /** Winning side, -1 for a draw, or null until the battle ends. */
  winner: number | null;
  /** Taps per side. */
  totals: number[];
  /** Accounts with at least one tap. */
  players: number;
  /** Accounts that used assisted tapping. */
  assisted: number;
}

export interface Comment {
  id: string;
  entryId: string;
  /** Empty when `removed`. */
  authorId: string;
  /** Empty when `removed`. */
  author: string;
  avatar: string | null;
  /** The author's preset 0..17, or null (always null when `removed`). */
  avatarPreset: number | null;
  /** Empty when `removed`. */
  text: string;
  createdAt: number;
  parentId: string | null;
  likes: number;
  liked: boolean;
  /** A deleted comment that still has replies: render "Comment removed" and keep the thread. */
  removed: boolean;
  /** The viewer has an open report on this comment: show "Reported" once and no Report action. */
  reported: boolean;
}

/** A top-level comment with its whole reply tree, flattened oldest first (`?view=thread`). */
export interface CommentThread extends Comment {
  replies: Comment[];
}

export interface BoardSnapshot {
  streamer: Streamer;
  entries: Entry[];
  nextCursor: string | null;
  revision: number;
  serverNow: number;
}

export interface DiscussionSnapshot {
  comments: Comment[];
  nextCursor: string | null;
}

/** `GET /api/entries/:id/comments?view=thread`: top-level comments paged, each with its replies. */
export interface ThreadSnapshot {
  comments: CommentThread[];
  nextCursor: string | null;
}

export interface LiveSnapshot {
  type: "snapshot";
  revision: number;
  serverNow: number;
  polls: Pick<Entry, "id" | "title" | "kind" | "options" | "endsAt" | "revealed" | "counts" | "total" | "mash">[];
  /** What the OBS overlay shows. The live room always sends it; loaders may leave it out. */
  overlay?: OverlayPublic | null;
}

/** `{type:"mash"}`: live totals, 5 times a second while a battle runs. */
export interface MashTick {
  type: "mash";
  id: string;
  phase: MashPhase;
  totals: number[];
  /** Whole seconds left. */
  left: number;
  endsAt: number | null;
  players: number;
  assisted: number;
  /** Taps a second across all players, for the host. */
  tps: number;
  serverNow: number;
}

/** One overlay source: `ref` is a poll or topic id, a Community card id, or null. */
export interface OverlaySourceRef {
  type: OverlaySource;
  ref: string | null;
}

/** The owner's overlay control state (`GET /api/overlay`). */
export interface OverlayState {
  air: OverlaySourceRef;
  preview: OverlaySourceRef;
  position: OverlayPosition;
  size: OverlaySize;
  /** Instant switch: every preview change goes on air at once. */
  instant: boolean;
  showResults: boolean;
  message: string;
  messageStyle: OverlayMessageStyle;
  revision: number;
}

/** The overlay state anyone may see. `message` is empty unless the message banner is on air. */
export type OverlayPublic = Omit<OverlayState, "preview" | "instant">;

export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface StreamerApplication {
  id: string;
  links: string[];
  note: string;
  status: ApplicationStatus;
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
}

export interface StreamerAccess {
  admin: boolean;
  canCreateStreamer: boolean;
  application: StreamerApplication | null;
}

export interface ApplicationReviewItem extends StreamerApplication {
  userId: string;
  name: string;
  email: string;
}

export interface ApplicationQueue {
  applications: ApplicationReviewItem[];
  nextCursor: string | null;
}

export type ReportReason = "illegal" | "harassment" | "spam" | "privacy" | "other";
export type ReportStatus = "open" | "actioned" | "dismissed";
export type ReportTargetKind = "entry" | "comment";

export interface ContentReport {
  id: string;
  targetKind: ReportTargetKind;
  targetId: string;
  reason: ReportReason;
  details: string;
  snapshot: string;
  status: ReportStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** Null when the reporter deleted their account. */
  reporterName: string | null;
  /** Null when the streamer page no longer exists. */
  streamerHandle: string | null;
  /** The topic or poll that holds the reported content, or null once the content is gone. */
  entryId: string | null;
}

export interface ReportQueue {
  reports: ContentReport[];
  nextCursor: string | null;
}

/** A linked topic shown on a stream ("Linked topics"). */
export interface EventTopic {
  id: string;
  title: string;
  category: string;
}

/** One scheduled stream (item 23). A weekly series is one row per occurrence sharing `seriesId`. */
export interface StreamEvent {
  id: string;
  seriesId: string | null;
  title: string;
  notes: string;
  startsAt: number;
  durationMin: number;
  platform: StreamPlatform;
  url: string;
  /** What it shows as now: upcoming (`scheduled`), `live`, `ended` or `cancelled`. */
  status: StreamEventStatus;
  vodUrl: string | null;
  /** Weekday bitmask (bit 0 = Sunday). 0 for a one-off stream. */
  repeatDays: number;
  /** Last moment a series may occur, or null. */
  repeatUntil: number | null;
  /** The zone the owner scheduled it in. Viewers see it in their own zone. */
  tz: string;
  topics: EventTopic[];
  /** Last change. "Add to calendar" uses it for DTSTAMP and SEQUENCE, the same as the .ics feed. */
  updatedAt: number;
}

export interface ScheduleSnapshot {
  events: StreamEvent[];
  serverNow: number;
}

/** A Community card (item 24). `buttonTarget` is `tab:<view>` or an https link. */
export interface CommunityCard {
  id: string;
  icon: CardIcon | null;
  title: string;
  body: string;
  buttonLabel: string | null;
  buttonTarget: string | null;
}

/** A support or donation link-out (item 34). `label` is only set for `other`. */
export interface SupportLink {
  id: string;
  kind: SupportLinkKind;
  label: string | null;
  url: string;
}

export interface SupportSettings {
  links: SupportLink[];
  /** Show the links in About. */
  visible: boolean;
  /** Also show a Support card in Community. */
  card: boolean;
}

/** Content the overlay sources other than polls show. Every field is already public on the streamer page. */
export interface OverlayData {
  /** The newest polls and Mash Battles, for the poll picker. */
  polls: { id: string; title: string; mash: boolean }[];
  topics: {
    id: string;
    title: string;
    category: string;
    author: string;
    avatar: string | null;
    avatarPreset: number | null;
    likes: number;
  }[];
  cards: {
    id: string;
    icon: CardIcon | null;
    title: string;
    body: string;
    label: string | null;
    target: string | null;
  }[];
  /** The next scheduled stream, or null. */
  next: { title: string; startsAt: number } | null;
  /** The first support link, or null. */
  support: { kind: SupportLinkKind; label: string | null; url: string } | null;
}

/* Admin and admin-security API shapes. */

export type ModerationTarget = (typeof MODERATION_TARGETS)[number];

/** Why an admin froze or suspended a page: the viewer report reasons plus impersonation. */
export const MODERATION_REASONS = ["illegal", "harassment", "spam", "privacy", "impersonation", "other"] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export const PAGE_ACTIONS = ["freeze", "unfreeze", "suspend", "unsuspend"] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

/** `ADMIN_STEP_UP`: `off` skips step-up, `report` allows admin work and logs a missing step-up, `enforce` blocks it. */
export type StepUpMode = "off" | "report" | "enforce";

/**
 * What the admin's session needs before admin data opens.
 * - `none`: nothing (or the mode does not block).
 * - `keys`: fewer than two security keys are registered (enforce only).
 * - `step_up`: no step-up in this session in the last 15 minutes (enforce only).
 */
export type StepUpNeed = "none" | "keys" | "step_up";

export interface StepUpStatus {
  mode: StepUpMode;
  keys: number;
  requiredKeys: number;
  /** Last step-up in this session, or null. */
  verifiedAt: number | null;
  /** When the 15-minute step-up ends, or null when it is not fresh. */
  freshUntil: number | null;
  /** Whether this session may register a key now, and why not when it may not. */
  canRegister: boolean;
  registerBlock: "none" | "sign_in_again" | "step_up" | "limit";
  need: StepUpNeed;
  serverNow: number;
}

export interface SecurityKey {
  id: string;
  name: string;
  createdAt: number | null;
  lastUsedAt: number | null;
  backedUp: boolean;
  transports: string[];
}

/** A person as admin screens show them: name and picture only, with the email when it is real. */
export interface AdminPerson {
  id: string | null;
  name: string;
  avatar: string | null;
  avatarPreset: number | null;
}

export interface ModerationEvent {
  id: string;
  action: string;
  reason: string;
  note: string;
  notifyOwner: boolean;
  actor: string | null;
  createdAt: number;
}

export interface AdminPage {
  id: string;
  handle: string;
  name: string;
  logo: string | null;
  avatar: string | null;
  ownerAvatarPreset: number | null;
  isOfficial: boolean;
  status: StreamerStatus;
  statusReason: string | null;
  statusChangedAt: number | null;
  owner: AdminPerson & { email: string };
  topics: number;
  polls: number;
  /** Newest first, at most 10. */
  history: ModerationEvent[];
}

export interface AdminPageList {
  pages: AdminPage[];
  nextCursor: string | null;
}

export type ReportGroupFilter = "open" | "resolved" | "all";

export interface ReportGroup {
  streamer: Pick<AdminPage, "id" | "handle" | "name" | "logo" | "avatar" | "ownerAvatarPreset" | "status"> | null;
  streamerId: string;
  /** Reports in the filter. */
  reports: number;
  /** Distinct reported items in the filter. */
  items: number;
  open: number;
  last30Days: number;
  newest: number;
  reasons: { reason: ReportReason; count: number }[];
}

export interface ReportGroupList {
  groups: ReportGroup[];
  /** Cursor for the next page of groups, or null on the last page. */
  next: string | null;
}

export interface ReportItemReport {
  id: string;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  createdAt: number;
  reporter: AdminPerson | null;
}

/** All reports about one topic, poll or comment ("Reported by N people"). */
export interface ReportItem {
  targetKind: ReportTargetKind;
  targetId: string;
  /** The topic or poll that holds it, or null once it is gone. */
  entryId: string | null;
  snapshot: string;
  author: AdminPerson | null;
  /** `open` while any report is open, else how the item was resolved. */
  status: ReportStatus;
  resolvedAt: number | null;
  /** Every report about the item in the filter, though `reports` holds only the newest ones. */
  reportCount: number;
  openCount: number;
  reasons: { reason: ReportReason; count: number }[];
  /** The newest reports, up to a fixed limit. */
  reports: ReportItemReport[];
}

export interface ReportItemList {
  streamer: ReportGroup["streamer"];
  items: ReportItem[];
  /** Cursor for the next page of items, or null on the last page. */
  next: string | null;
}

export interface IdeaStatusInput {
  status: EntryStatus | null;
  reason?: string;
}
