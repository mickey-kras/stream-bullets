import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouterContextProvider } from 'react-router';
import { handleError } from '../app/entry.server';

afterEach(() => vi.restoreAllMocks());

describe('server route error logging', () => {
  it('does not expose exception details, URLs, or credentials in logs', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    handleError(new Error('SQL failed: session token secret-value'), {
      request: new Request('https://app.example/api?code=oauth-secret'),
      context: new RouterContextProvider(), params: {},
    });
    expect(log.mock.calls).toEqual([['server_request_failed']]);
  });

  it('does not report a cancelled request as a server failure', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    handleError(new Error('cancelled'), {
      request: new Request('https://app.example/', { signal: controller.signal }),
      context: new RouterContextProvider(), params: {},
    });
    expect(log).not.toHaveBeenCalled();
  });
});
