import { t } from "../i18n";

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

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response: Response = await fetch(url, { ...init, credentials: "same-origin" });
  const body: unknown = await response.json();
  if (!response.ok) throw apiError(response.status, body, t("common.failed"));
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
  method: "PUT" | "PATCH" | "DELETE",
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t("common.failed");
}
