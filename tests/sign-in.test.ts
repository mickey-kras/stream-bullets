import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
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
    });
  });
});
