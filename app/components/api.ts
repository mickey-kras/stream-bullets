import { getLocale, intlLocale, t, type MessageId } from "../i18n";

// API error with a stable optional server code.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    // Optional machine-readable values for the code, for example `retryAt` for `handle_cooldown`.
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

// Keep only string values. Other shapes are not part of the error contract.
function errorDetails(value: unknown): Record<string, string> {
  const details: Record<string, string> = {};
  if (typeof value !== "object" || value === null) return details;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") details[key] = item;
  }
  return details;
}

// Parse error body; use fallback when no message exists.
export function apiError(status: number, body: unknown, fallback: string): ApiError {
  const record: Record<string, unknown> = typeof body === "object" && body !== null ? { ...body } : {};
  const message: string = typeof record.error === "string" ? record.error : fallback;
  const code: string | null = typeof record.code === "string" ? record.code : null;
  return new ApiError(message, status, code, errorDetails(record.details));
}

const NOT_JSON: unique symbol = Symbol("not JSON");

// Fetch same-origin JSON. Failed responses and non-JSON bodies throw ApiError; absent messages use fallback.
export async function requestJson<T>(
  url: string,
  init?: RequestInit,
  fallback: string = t("common.failed"),
): Promise<T> {
  const response: Response = await fetch(url, { ...init, credentials: "same-origin" });
  const body: unknown = await response.json().catch((): typeof NOT_JSON => NOT_JSON);
  if (!response.ok) throw apiError(response.status, body, fallback);
  if (body === NOT_JSON) throw new ApiError(fallback, response.status, null);
  return body as T;
}

// Retry this admin action after fresh step-up.
export function needsStepUp(error: unknown): boolean {
  return error instanceof ApiError && error.code === "step_up_required";
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function sendJson<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  init: Pick<RequestInit, "keepalive"> = {},
): Promise<T> {
  return requestJson<T>(url, {
    ...init,
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

const statusMessages: Readonly<Partial<Record<number, MessageId>>> = {
  400: "error.invalid",
  401: "error.signIn",
  403: "error.forbidden",
  404: "error.notFoundBody",
  409: "error.conflict",
  413: "error.tooLarge",
  415: "error.invalid",
  422: "error.invalid",
};

const codeMessages: Readonly<Record<string, MessageId>> = {
  keys_required: "keys.setupIntro",
  layout_limit: "overlay.layout.limit",
  step_up_required: "keys.confirmTitle",
  challenge_expired: "keys.cancelled",
  key_limit: "keys.limit",
  sign_in_again: "keys.signInAgain",
  key_failed: "keys.failed",
  key_unknown: "keys.failed",
  key_conflict: "keys.alreadyRegistered",
  other_key_required: "keys.confirmRemove",
  last_key: "keys.onlyKey",
  bug_template_empty: "ideas.form.fillTemplate",
  binary_options_invalid: "error.binaryOptions",
  invalid_image: "upload.invalid",
  handle_taken: "error.handleTaken",
  invalid_schedule_date: "error.scheduleDate",
  schedule_no_occurrences: "error.scheduleDays",
  idea_not_under_review: "error.ideaDelete",
  channel_conflict: "channels.conflict",
  page_frozen: "error.pageFrozen",
  page_suspended: "error.pageSuspended",
  // The refusals of the alert host (ALERT_REFUSALS in app/lib/alert-control.ts).
  alerts_off_stream: "overlay.alerts.refusal.alertsOffStream",
  goal_off: "overlay.alerts.refusal.goalOff",
  alert_gone: "overlay.alerts.refusal.alertGone",
  alerts_muted: "overlay.alerts.refusal.alertsMuted",
  alerts_unwatched: "overlay.alerts.refusal.alertsUnwatched",
  alert_rule_off: "overlay.alerts.refusal.alertRuleOff",
  alerts_full: "overlay.alerts.refusal.alertsFull",
  alerts_unavailable: "overlay.alerts.refusal.alertsUnavailable",
};

// Show the date of the next allowed handle change in the reader's language.
function handleCooldownMessage(error: ApiError): string {
  const retryAt: string | undefined = error.details.retryAt;
  const retryTime: number = retryAt ? Date.parse(retryAt) : Number.NaN;
  if (!Number.isFinite(retryTime)) return t("error.handleCooldown");
  const date: string = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long", timeZone: "UTC" }).format(retryTime);
  return t("error.handleCooldownDate", { date });
}

// No known code. English keeps the server text, because it names the fix. Other languages use the status text.
function statusMessage(error: ApiError): string {
  if (error.status === 423) return t("error.pageLocked");
  if (error.status === 429) return t("error.rateLimit");
  if (getLocale() === "en") return error.message || t("common.failed");
  return t(statusMessages[error.status] ?? "common.failed");
}

// The catalog text for these codes is a dialog title or a button label. The English server text says what to do.
const serverTextCodes: ReadonlySet<string> = new Set<string>(["step_up_required", "other_key_required"]);

function keepsServerText(error: ApiError): boolean {
  return getLocale() === "en" && error.code !== null && serverTextCodes.has(error.code) && error.message !== "";
}

function apiErrorMessage(error: ApiError): string {
  if (error.code === "handle_cooldown") return handleCooldownMessage(error);
  if (keepsServerText(error)) return error.message;
  const id: MessageId | undefined = error.code ? codeMessages[error.code] : undefined;
  return id ? t(id) : statusMessage(error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return apiErrorMessage(error);
  if (error instanceof TypeError || error instanceof DOMException) return t("common.failed");
  return error instanceof Error ? error.message : t("common.failed");
}
