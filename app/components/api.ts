export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response: Response = await fetch(url, { ...init, credentials: 'same-origin' });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message: string = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'The request failed. Please try again.';
    throw new Error(message);
  }
  return body as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed. Please try again.';
}
