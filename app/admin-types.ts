import type { MODERATION_TARGETS } from "../db/enums";
import type { EntryStatus, ReportReason, ReportStatus, ReportTargetKind, StreamerStatus } from "./types";

/* Admin and admin-security API shapes (Phase 6). They live apart from app/types.ts so parallel phases do not
   edit the same file. */

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
