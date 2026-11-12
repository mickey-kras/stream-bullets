import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../app/i18n";
import { pendingSave } from "../app/lib/pending-save";
import { saveLocaleCookie, savePrefsCookie } from "../app/lib/prefs";

describe("the account save of display preferences", (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("sends the last change one second after it", (): void => {
    vi.useFakeTimers();
    const send = vi.fn();
    const save = pendingSave<string>(send, 1_000);
    save.schedule("115");
    vi.advanceTimersByTime(600);
    save.schedule("130");
    vi.advanceTimersByTime(999);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send.mock.calls).toEqual([["130", false]]);
    save.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a waiting change at once, with keepalive, when the dialog closes or the page goes", (): void => {
    vi.useFakeTimers();
    const send = vi.fn();
    const save = pendingSave<string>(send, 1_000);
    save.flush();
    expect(send).not.toHaveBeenCalled();
    save.schedule("130");
    save.flush();
    expect(send.mock.calls).toEqual([["130", true]]);
    vi.advanceTimersByTime(5_000);
    save.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("the preference cookies", (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it("writes through the Cookie Store API where the browser has it", async (): Promise<void> => {
    const set = vi.fn(async (): Promise<void> => undefined);
    const fetcher = vi.fn();
    vi.stubGlobal("cookieStore", { set });
    vi.stubGlobal("fetch", fetcher);
    await saveLocaleCookie("de");
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: "sb_locale", value: "de", path: "/" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks the server to set the cookie where the Cookie Store API is missing", async (): Promise<void> => {
    vi.stubGlobal("cookieStore", undefined);
    const fetcher = vi.fn(
      async (_url: string, _init: RequestInit): Promise<Response> => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await saveLocaleCookie("pt-BR");
    await savePrefsCookie({ text: "130" });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.body])).toEqual([
      ["/api/preference-cookies", JSON.stringify({ locale: "pt-BR" })],
      ["/api/preference-cookies", JSON.stringify({ prefs: { text: "130" } })],
    ]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", keepalive: true, credentials: "same-origin" });
    fetcher.mockResolvedValue(new Response(null, { status: 403 }));
    await expect(saveLocaleCookie("de")).rejects.toThrow(t("common.failed"));
    await expect(savePrefsCookie({ text: "100" })).resolves.toBeUndefined();
  });
});
