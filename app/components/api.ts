import { getLocale, t, type MessageId } from "../i18n";

/** An API failure with the server's stable `code` (for example `step_up_required`), when it sent one. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Turns a failed response body into an ApiError, with `fallback` when the body has no message. */
export function apiError(status: number, body: unknown, fallback: string): ApiError {
  const record: Record<string, unknown> = typeof body === "object" && body !== null ? { ...body } : {};
  const message: string = typeof record.error === "string" ? record.error : fallback;
  return new ApiError(message, status, typeof record.code === "string" ? record.code : null);
}

const NOT_JSON: unique symbol = Symbol("not JSON");

/**
 * Fetches same-origin JSON. A failed response, or a body that is not JSON (a proxy error page, for example),
 * throws an ApiError with `fallback` as its message when the server sent none.
 */
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

/** The server wants a fresh security-key check before it repeats this admin action. */
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
  415: "upload.invalid",
  422: "error.invalid",
  429: "error.rateLimit",
};

const codeMessages: Readonly<Record<string, MessageId>> = {
  keys_required: "keys.setupIntro",
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
  invalid_image: "upload.invalid",
  handle_taken: "error.handleTaken",
  invalid_schedule_date: "error.scheduleDate",
  schedule_no_occurrences: "error.scheduleDays",
  idea_not_under_review: "error.ideaDelete",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && getLocale() !== "en") {
    return t((error.code ? codeMessages[error.code] : undefined) ?? statusMessages[error.status] ?? "common.failed");
  }
  if (error instanceof TypeError || error instanceof DOMException) return t("common.failed");
  return error instanceof Error ? error.message : t("common.failed");
}
