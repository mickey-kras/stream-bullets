import { afterEach, describe, expect, it } from "vitest";
import { supportLine } from "../app/components/tools/live-support";
import { DEFAULT_LOCALE, loadCatalog, setLocaleSource, type Locale } from "../app/i18n";
import { SUPPORT_KINDS, type SupportKind } from "../app/lib/activity";
import { ALERT_KINDS } from "../app/lib/alerts";
import type { LiveSupportRow } from "../app/lib/live-chat";
import { supportText, type SupportFacts } from "../app/lib/support-line";

// The one text of a support event: the rows of Live and the dock, the alert banner and the mark in chat use it.

function facts(kind: SupportKind, more: Partial<SupportFacts> = {}): SupportFacts {
  return { kind, platform: "twitch", amount: null, currency: null, ...more };
}

afterEach((): void => {
  setLocaleSource((): Locale => DEFAULT_LOCALE);
});

describe("the text of a support event", (): void => {
  it("is the line of the row in Live for each kind", (): void => {
    for (const kind of SUPPORT_KINDS) {
      const row: LiveSupportRow = {
        kind: "support",
        id: `twitch:${kind}`,
        seq: 1,
        event: kind,
        platform: "twitch",
        name: "Viewer 1",
        amount: 3_000_000,
        currency: "USD",
        text: "A text of the supporter",
        receivedAt: 1,
      };
      const text: string = supportText(facts(kind, { amount: 3_000_000, currency: "USD" }));
      expect(supportLine(row)).toBe(text);
      // The name and the text of the supporter are not in the line.
      expect(text).not.toContain("Viewer 1");
      expect(text).not.toContain("A text of the supporter");
    }
  });

  it("has a text for each kind that makes an alert", (): void => {
    const texts: string[] = ALERT_KINDS.map((kind): string => supportText(facts(kind, { amount: 2 })));
    expect(new Set(texts).size).toBe(ALERT_KINDS.length);
  });

  it("has no count for a first month, and names the gifts of YouTube memberships", (): void => {
    expect(supportText(facts("subscription", { amount: 1 }))).toBe("subscribed");
    expect(supportText(facts("subscription"))).toBe("subscribed");
    expect(supportText(facts("membership", { amount: 3, platform: "youtube" }))).toBe("member for 3 months");
    expect(supportText(facts("gift", { amount: 5, platform: "youtube" }))).toBe("gave 5 memberships");
    expect(supportText(facts("gift", { amount: 5, platform: "kick" }))).toBe("gave 5 subscriptions");
  });

  it("shows money from micros, and zero for a money event without an amount", (): void => {
    expect(supportText(facts("super_chat", { amount: 5_000_000, currency: "USD" }))).toBe("Super Chat: $5.00");
    expect(supportText(facts("tip", { platform: "direct", currency: "EUR" }))).toBe("tip: €0.00");
    expect(supportText(facts("tip", { platform: "direct" }))).toBe("tip: 0");
  });

  it("follows the plural rules and the number format of the language", async (): Promise<void> => {
    await Promise.all([loadCatalog("ru"), loadCatalog("de")]);
    setLocaleSource((): Locale => "ru");
    expect(supportText(facts("gift", { amount: 1 }))).toBe("дарит 1 подписку");
    expect(supportText(facts("gift", { amount: 3 }))).toBe("дарит 3 подписки");
    expect(supportText(facts("gift", { amount: 5 }))).toBe("дарит 5 подписок");
    setLocaleSource((): Locale => "de");
    expect(supportText(facts("raid", { amount: 1200 }))).toContain("1.200");
  });
});
