import type {
  CARD_ICONS,
  CARD_TABS,
  ENTRY_STATUSES,
  LOCALES,
  MASH_PHASES,
  OVERLAY_MESSAGE_STYLES,
  OVERLAY_POSITIONS,
  OVERLAY_SIZES,
  OVERLAY_SOURCES,
  STREAM_EVENT_STATUSES,
  STREAM_PLATFORMS,
  STREAMER_STATUSES,
  SUPPORT_LINK_KINDS,
} from "../db/enums";

export type EntryKind = "topic" | "choice" | "binary";
export type SortOrder = "newest" | "top";
export type Reaction = -1 | 0 | 1;

export type Locale = (typeof LOCALES)[number];
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
  /** Page logo. The client falls back to `avatar`, then the default spaceman. */
  logo: string | null;
  /** The official StreamBullets page, pinned first in the directory. */
  isOfficial: boolean;
  /** `frozen` pages are public and read-only. `suspended` pages reach only their owner and admins. */
  status: StreamerStatus;
  /** Why the page is frozen or suspended. Only set for the owner and admins; null for everyone else. */
  statusReason: string | null;
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
}

export interface Comment {
  id: string;
  entryId: string;
  /** Empty when `removed`. */
  authorId: string;
  /** Empty when `removed`. */
  author: string;
  avatar: string | null;
  /** Empty when `removed`. */
  text: string;
  createdAt: number;
  parentId: string | null;
  likes: number;
  liked: boolean;
  /** A deleted comment that still has replies: render "Comment removed" and keep the thread. */
  removed: boolean;
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
  polls: Pick<Entry, "id" | "title" | "kind" | "options" | "endsAt" | "revealed" | "counts" | "total">[];
}

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
