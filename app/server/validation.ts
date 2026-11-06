import { z } from "zod";
import { AVATAR_PRESET_COUNT, LOCALES } from "../../db/enums";

const id = z.string().uuid();
const line = (max: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);
const text = (max: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{Cc}]|[\t\n\r])*$/u);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u, "Use a single-line display name.");

export const streamerSchema = z
  .object({
    handle: z.string().regex(/^[a-z0-9_]{3,30}$/u),
    name: displayNameSchema,
    about: z.string().trim().max(2000).default(""),
  })
  .strict();

export const entryActionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("create"),
        kind: z.enum(["topic", "choice", "binary"]),
        title: line(160),
        body: text(2000).optional(),
        category: z.enum(["Tech & setups", "Gaming", "Creative", "Just chatting"]).optional(),
        options: z.array(line(80)).min(2).max(6).optional(),
        duration: z.union([z.literal(0), z.number().int().min(15).max(3600)]).default(0),
      })
      .strict(),
    z.object({ action: z.literal("vote"), id, choice: z.number().int().min(0).max(5) }).strict(),
    z.object({ action: z.literal("react"), id, value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }).strict(),
    z.object({ action: z.literal("reveal"), id }).strict(),
    z.object({ action: z.literal("delete"), id }).strict(),
    z.object({ action: z.literal("comment"), id, text: text(2000), parentId: id.nullable().optional() }).strict(),
  ])
  .superRefine((value, context) => {
    if (value.action !== "create") return;
    if (value.kind === "topic" && (!value.body || !value.category || value.title.length > 100)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Topics need a title up to 100 characters, details, and a category.",
      });
    }
    if (
      value.kind === "choice" &&
      (!value.options?.length ||
        new Set(value.options.map((option: string) => option.toLowerCase())).size !== value.options.length)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Add 2 to 6 different poll options." });
    }
  });

export const commentActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("like"), id, liked: z.boolean() }).strict(),
  z.object({ action: z.literal("delete"), id }).strict(),
]);

export const entryQuerySchema = z
  .object({
    kind: z.enum(["topics", "polls"]).default("topics"),
    sort: z.enum(["newest", "top"]).default("newest"),
    query: z.string().trim().max(100).default(""),
    cursor: z.string().max(1024).nullable().default(null),
  })
  .strict();

export const commentQuerySchema = z
  .object({
    sort: z.enum(["newest", "top"]).default("newest"),
    cursor: z.string().max(1024).nullable().default(null),
    /** `flat` (default) lists every comment; `thread` pages top-level comments with their replies. */
    view: z.enum(["flat", "thread"]).default("flat"),
  })
  .strict();

/** `GET /api/streamers`: official pages first, then by handle. `query` matches the name or handle. */
export const directoryQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^(?:[01]\.)?[a-z0-9_]{3,30}$/u)
      .nullable()
      .default(null),
    query: z.string().trim().max(60).default(""),
  })
  .strict();

const applicationLink = z
  .string()
  .trim()
  .max(200)
  .url()
  .refine((value: string): boolean => {
    // Zod still runs refinements after a failed url() check, so parse defensively.
    const url = URL.canParse(value) ? new URL(value) : null;
    return url?.protocol === "https:" && !url.username && !url.password;
  }, "Use HTTPS links to your public channel pages.");

export const applicationSchema = z
  .object({
    links: z
      .array(applicationLink)
      .min(1, "Add at least one link to a channel you stream on.")
      .max(5, "Add up to 5 links.")
      .refine(
        (links: string[]): boolean => new Set(links.map((link: string) => link.toLowerCase())).size === links.length,
        "Remove duplicate links.",
      ),
    note: z
      .string()
      .trim()
      .max(1000)
      .regex(/^(?:[^\p{Cc}]|[\t\n\r])*$/u)
      .default(""),
  })
  .strict();

export const applicationQuerySchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected"]).default("pending"),
    cursor: z.string().max(1024).nullable().default(null),
  })
  .strict();

export const applicationReviewSchema = z.object({ id, decision: z.enum(["approved", "rejected"]) }).strict();

export const reportReasons = ["illegal", "harassment", "spam", "privacy", "other"] as const;

export const reportSchema = z
  .object({
    targetKind: z.enum(["entry", "comment"]),
    targetId: id,
    reason: z.enum(reportReasons),
    details: z
      .string()
      .trim()
      .max(1000, "Keep the details under 1000 characters.")
      .regex(/^(?:[^\p{Cc}]|[\t\n\r])*$/u)
      .default(""),
  })
  .strict()
  .refine(
    (value): boolean => !["illegal", "other"].includes(value.reason) || value.details.length > 0,
    "Explain why this content breaks the law or the community rules.",
  );

export const reportQuerySchema = z
  .object({
    status: z.enum(["open", "actioned", "dismissed"]).default("open"),
    cursor: z.string().max(1024).nullable().default(null),
  })
  .strict();

export const reportResolutionSchema = z.object({ id, action: z.enum(["remove", "dismiss"]) }).strict();

export type ReportInput = z.input<typeof reportSchema>;
export type ReportQuery = z.input<typeof reportQuerySchema>;
export type ReportResolution = z.infer<typeof reportResolutionSchema>;
export type ApplicationInput = z.infer<typeof applicationSchema>;
export type ApplicationQuery = z.infer<typeof applicationQuerySchema>;
export type ApplicationReview = z.infer<typeof applicationReviewSchema>;
export type StreamerInput = z.infer<typeof streamerSchema>;
export type EntryAction = z.infer<typeof entryActionSchema>;
export type CommentAction = z.infer<typeof commentActionSchema>;
export type EntryQuery = z.infer<typeof entryQuerySchema>;
export type CommentQuery = z.input<typeof commentQuerySchema>;
export type DirectoryQuery = z.input<typeof directoryQuerySchema>;

export const handleSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,30}$/u, "Use 3 to 30 lowercase letters, numbers or underscores.");

/** `PATCH /api/profile`: the account's display name and preset avatar (null clears the preset). */
export const profileSchema = z
  .object({
    name: displayNameSchema.optional(),
    avatarPreset: z
      .number()
      .int()
      .min(0)
      .max(AVATAR_PRESET_COUNT - 1)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value): boolean => value.name !== undefined || value.avatarPreset !== undefined, "Nothing to save.");

/** `PATCH /api/me/locale`. Null forgets the saved language. */
export const localeSchema = z.object({ locale: z.enum(LOCALES).nullable() }).strict();

/** `PATCH /api/me/preferences`: the whole preferences object, replacing what was saved. */
export const displayPrefsSchema = z
  .object({
    cvd: z.enum(["default", "pd", "tri"]),
    contrast: z.enum(["default", "high"]),
    motion: z.enum(["system", "reduce", "full"]),
    text: z.enum(["100", "115", "130"]),
    underline: z.boolean(),
    font: z.enum(["default", "readable"]),
    mashAssist: z.enum(["off", "hold", "toggle"]),
    srInterval: z.enum(["2", "5", "10", "off"]),
    shortcuts: z.boolean(),
  })
  .partial()
  .strict();

/** Reads saved preferences. Keys or values a later release no longer knows are dropped one by one. */
export function readDisplayPrefs(value: unknown): z.infer<typeof displayPrefsSchema> | null {
  if (typeof value !== "string") return null;
  let saved: unknown;
  try {
    saved = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return null;
  const shape = displayPrefsSchema.shape;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(saved)) {
    const schema = shape[key as keyof typeof shape];
    const parsed = schema?.safeParse(field);
    if (parsed?.success && parsed.data !== undefined) result[key] = parsed.data;
  }
  return result as z.infer<typeof displayPrefsSchema>;
}

/** `PATCH /api/streamer`: edit your page. `logoMode: "profile"` drops the uploaded logo. */
export const streamerEditSchema = z
  .object({
    name: displayNameSchema.optional(),
    about: z.string().trim().max(2000).optional(),
    handle: handleSchema.optional(),
    logoMode: z.enum(["profile", "logo"]).optional(),
  })
  .strict()
  .refine((value): boolean => Object.values(value).some((field) => field !== undefined), "Nothing to save.");

export type ProfileInput = z.infer<typeof profileSchema>;
export type StreamerEdit = z.infer<typeof streamerEditSchema>;

export const accountDeletionSchema = z
  .object({ confirm: z.literal("DELETE", { error: "Type DELETE to confirm." }) })
  .strict();

/** The non-routable addresses TikTok and Instagram accounts get (R5). Never shown or mailed. */
export function isPlaceholderEmail(email: string): boolean {
  return /@(?:[a-z0-9-]+\.)?(?:tiktok|instagram)(?:\.placeholder)?\.invalid$/iu.test(email);
}
