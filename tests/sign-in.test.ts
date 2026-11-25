import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { Reauthenticate } from "../app/components/shell/sign-in-dialog";
import { appContext, type AppEnv } from "../app/env";
import { loader } from "../app/routes/sign-in";

describe("sign-in recovery", () => {
  it("offers recovery when the provider rejects a revoked linking session", () => {
    const context = new RouterContextProvider();
    context.set(appContext, {
      env: { TWITCH_CLIENT_ID: "test-client", TWITCH_CLIENT_SECRET: "test-secret" } as AppEnv,
      nonce: "test",
      responseHeaders: new Headers(),
    });
    const url = new URL("https://example.test/sign-in?error=unable_to_link_account");
    expect(loader({ context, request: new Request(url), url, pattern: "/sign-in", params: {} })).toEqual({
      providers: ["twitch"],
      error: "loginMethods.failed",
      next: "/settings",
    });
  });

  it("returns the retry to a same-origin `next` only", () => {
    const context = new RouterContextProvider();
    context.set(appContext, { env: {} as AppEnv, nonce: "test", responseHeaders: new Headers() });
    const next = (value: string): string => {
      const url = new URL(`https://example.test/sign-in?error=x&next=${encodeURIComponent(value)}`);
      return loader({ context, request: new Request(url), url, pattern: "/sign-in", params: {} }).next;
    };
    expect(next("/@alice?intent=suggest")).toBe("/@alice?intent=suggest");
    expect(next("//evil.example")).toBe("/settings");
    expect(next("https://evil.example/")).toBe("/settings");
  });
});

describe("the reauthentication prompt", () => {
  it("shows only the provider buttons: no display name, no eligibility checkbox, no hint and no legal line", () => {
    const html: string = renderToStaticMarkup(
      createElement(Reauthenticate, { providers: ["google", "twitch"], callbackURL: "/tools" }),
    );
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Twitch");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<label");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Watching on YouTube?");
    expect(html).not.toContain("or older");
  });
});
