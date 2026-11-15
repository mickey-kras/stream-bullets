import type { Locale } from "./i18n";
import type { OverlayLayers } from "./lib/overlay-layers";
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

// Sign-in dialog provider order.
export type Provider = "google" | "tiktok" | "twitch" | "instagram";

// The API exposes `choice` entries with an `entry_mash` row as `mash`.
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

// Optional display settings. Missing keys use defaults.
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

  avatar: string | null;
  // Preset 0..17 or null. Without an upload or preset, use DEFAULT_AVATAR_PRESET (14).
  avatarPreset: number | null;
  // Null uses the cookie or browser locale.
  locale: Locale | null;
  // Null until preferences are saved.
  displayPrefs: DisplayPrefs | null;
}

export interface Streamer {
  id: string;
  handle: string;
  name: string;
  about: string;
  // Owner's uploaded picture.
  avatar: string | null;
  background: string | null;
  ownerId: string;
  // Logo fallback: `avatar`, `ownerAvatarPreset`, default spaceman.
  logo: string | null;
  // Owner's preset (0..17), used without an upload.
  ownerAvatarPreset: number | null;
  // Official page; pinned first in the directory.
  isOfficial: boolean;
  // Frozen: public, read-only. Suspended: owner and admins only.
  status: StreamerStatus;
  // Owner and admins only; null for other viewers.
  statusReason: string | null;
  // Last freeze or suspension (ms). Owner and admins only; null otherwise.
  statusChangedAt: number | null;
  // Owner only; null otherwise. Handle changes require 30 days between updates.
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
  // Author preset (0..17) or null.
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
  // Official Ideas board only; null elsewhere.
  status: EntryStatus | null;
  // Reason shown for `declined`.
  statusReason: string | null;
  // Viewer has an open report.
  reported: boolean;
  // Mash state; null for other kinds. `counts` holds players per side.
  mash: MashState | null;
}

// Sides use entry options; each viewer's vote selects their side.
export interface MashState {
  durationS: number;
  // Stored phase. Use mashPhaseAt() for the current phase.
  phase: MashPhase;
  startsAt: number | null;
  endsAt: number | null;
  // Winning side; -1 for a draw, null until finished.
  winner: number | null;

  totals: number[];
  // Accounts with at least one tap.
  players: number;

  assisted: number;
}

export interface Comment {
  id: string;
  entryId: string;
  // Empty when removed.
  authorId: string;
  // Empty when removed.
  author: string;
  avatar: string | null;
  // Author preset (0..17); null when removed.
  avatarPreset: number | null;
  // Empty when removed.
  text: string;
  createdAt: number;
  parentId: string | null;
  likes: number;
  liked: boolean;
  // Deleted parent with replies. Render "Comment removed" and retain the thread.
  removed: boolean;
  // Show "Reported" and hide Report when true.
  reported: boolean;
}

// Top-level comment with replies flattened oldest first (`?view=thread`).
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

// Paged top-level comments with their replies (`?view=thread`).
export interface ThreadSnapshot {
  comments: CommentThread[];
  nextCursor: string | null;
}

export interface LiveSnapshot {
  type: "snapshot";
  revision: number;
  serverNow: number;
  polls: Pick<Entry, "id" | "title" | "kind" | "options" | "endsAt" | "revealed" | "counts" | "total" | "mash">[];
  // Always sent by the live room; optional in loaders.
  overlay?: OverlayPublic | null;
}

// Live Mash totals at 5 Hz during a battle.
export interface MashTick {
  type: "mash";
  id: string;
  phase: MashPhase;
  totals: number[];
  // Whole seconds.
  left: number;
  endsAt: number | null;
  players: number;
  assisted: number;
  // Host's tap rate across all players.
  tps: number;
  serverNow: number;
}

// `ref`: poll, topic or Community card ID, or null.
export interface OverlaySourceRef {
  type: OverlaySource;
  ref: string | null;
}

// Owner control state (`GET /api/overlay`).
export interface OverlayState {
  air: OverlaySourceRef;
  preview: OverlaySourceRef;
  position: OverlayPosition;
  size: OverlaySize;
  // Publish preview changes immediately.
  instant: boolean;
  showResults: boolean;
  message: string;
  messageStyle: OverlayMessageStyle;
  // Chat and characters layers in the 1920x1080 design space. Public: OBS renders them.
  layers: OverlayLayers;
  revision: number;
}

// Public state. `message` is empty unless its banner is on air.
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
  // Null after reporter account deletion.
  reporterName: string | null;
  // Null after page deletion.
  streamerHandle: string | null;
  // Containing topic or poll; null after deletion.
  entryId: string | null;
}

export interface ReportQueue {
  reports: ContentReport[];
  nextCursor: string | null;
}

export interface EventTopic {
  id: string;
  title: string;
  category: string;
}

// One occurrence per row; weekly occurrences share `seriesId`.
export interface StreamEvent {
  id: string;
  seriesId: string | null;
  title: string;
  notes: string;
  startsAt: number;
  durationMin: number;
  platform: StreamPlatform;
  url: string;
  // Current status: scheduled, live, ended or cancelled.
  status: StreamEventStatus;
  vodUrl: string | null;
  // Weekday bits: 0 = Sunday. Zero means one-off.
  repeatDays: number;
  // Last allowed series occurrence; null if unlimited.
  repeatUntil: number | null;
  // Owner's scheduling zone. Viewers use their own zone.
  tz: string;
  topics: EventTopic[];
  // Last change; shared by download and feed DTSTAMP/SEQUENCE.
  updatedAt: number;
}

export interface ScheduleSnapshot {
  events: StreamEvent[];
  serverNow: number;
}

// `buttonTarget`: `tab:<view>` or HTTPS URL.
export interface CommunityCard {
  id: string;
  icon: CardIcon | null;
  title: string;
  body: string;
  buttonLabel: string | null;
  buttonTarget: string | null;
}

// External support link. `label` applies only to `other`.
export interface SupportLink {
  id: string;
  kind: SupportLinkKind;
  label: string | null;
  url: string;
}

export interface SupportSettings {
  links: SupportLink[];

  visible: boolean;

  card: boolean;
}

// Public content for non-poll overlay sources.
export interface OverlayData {
  // Newest polls and Mash Battles for the picker.
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

  next: { title: string; startsAt: number } | null;

  support: { kind: SupportLinkKind; label: string | null; url: string } | null;
}

export type ModerationTarget = (typeof MODERATION_TARGETS)[number];

// Viewer report reasons plus impersonation.
export const MODERATION_REASONS = ["illegal", "harassment", "spam", "privacy", "impersonation", "other"] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

export const PAGE_ACTIONS = ["freeze", "unfreeze", "suspend", "unsuspend"] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

// `off`: skip; `report`: allow and log missing step-up; `enforce`: block.
export type StepUpMode = "off" | "report" | "enforce";

// `none`: allowed. `keys`: fewer than two keys. `step_up`: no check in 15 minutes. Blocking states apply only
// in enforce mode.
export type StepUpNeed = "none" | "keys" | "step_up";

export interface StepUpStatus {
  mode: StepUpMode;
  keys: number;
  requiredKeys: number;
  // Session step-up time; null if absent.
  verifiedAt: number | null;
  // Step-up expiry (15 minutes); null if stale.
  freshUntil: number | null;
  // Key registration eligibility and refusal reason.
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

// Admin-visible identity; omit placeholder emails.
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
  // Newest first; maximum 10.
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

  reports: number;

  items: number;
  open: number;
  last30Days: number;
  newest: number;
  reasons: { reason: ReportReason; count: number }[];
}

export interface ReportGroupList {
  groups: ReportGroup[];
  // Null on the last page.
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

// Reports grouped by topic, poll or comment.
export interface ReportItem {
  targetKind: ReportTargetKind;
  targetId: string;
  // Containing entry; null after deletion.
  entryId: string | null;
  snapshot: string;
  author: AdminPerson | null;
  // Open while any report is open; otherwise the resolution.
  status: ReportStatus;
  resolvedAt: number | null;
  // Total filtered reports; `reports` includes only the newest.
  reportCount: number;
  openCount: number;
  reasons: { reason: ReportReason; count: number }[];
  // Newest reports, bounded by a fixed limit.
  reports: ReportItemReport[];
}

export interface ReportItemList {
  streamer: ReportGroup["streamer"];
  items: ReportItem[];
  // Null on the last page.
  next: string | null;
}

export interface IdeaStatusInput {
  status: EntryStatus | null;
  reason?: string;
}
