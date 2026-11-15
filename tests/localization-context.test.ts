import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiError, errorMessage } from "../app/components/api";
import { ceremonyError, errorText } from "../app/components/admin/webauthn";
import { environment, switchTemplate } from "../app/components/ideas/idea-dialog";
import { LOCALES, intlLocale, loadCatalog, setLocaleSource, t, tn, type Locale } from "../app/i18n";
import { BUG_TEMPLATES } from "../app/lib/bug-templates";
import { isUntouchedTemplate } from "../app/lib/ideas";
import { binaryOptions } from "../app/lib/polls";
import { entryActionSchema } from "../app/server/validation";
import { HttpError, errorResponse, readJson } from "../app/server/http.server";

afterEach((): void => {
  vi.unstubAllGlobals();
  setLocaleSource((): Locale => "en");
});

describe("localized participation", (): void => {
  it("uses the Polish counted participant form", async (): Promise<void> => {
    await loadCatalog("pl");
    setLocaleSource((): Locale => "pl");
    expect(tn("mash.participants", 1)).toBe("uczestnik");
    for (const count of [0, 2, 3, 4, 5, 22, 23, 24, 101]) {
      expect(tn("mash.participants", count)).toBe("uczestników");
    }
  });

  it.each(LOCALES)(
    "%s offers a localized bug template and rejects an empty report",
    async (locale: Locale): Promise<void> => {
      await loadCatalog(locale);
      setLocaleSource((): Locale => locale);
      const template: string = switchTemplate("", "feature", "bug");
      expect(template).toBe(BUG_TEMPLATES[locale]);
      expect(isUntouchedTemplate(template)).toBe(true);
      expect(switchTemplate(template, "bug", "feature")).toBe("");
      const filled: string = `${template}My draft 日本語 Марк`;
      expect(isUntouchedTemplate(filled)).toBe(false);
      expect(switchTemplate(filled, "bug", "feature")).toBe(filled);
      if (locale !== "en") expect(template).not.toBe(BUG_TEMPLATES.en);
      expect(t("ideas.aboutTab")).toContain("StreamBullets");
      for (const count of [0, 1, 2, 5, 21, 101, 1200]) {
        expect(tn("entry.comments", count)).toContain(new Intl.NumberFormat(intlLocale()).format(count));
        expect(tn("entry.comments", count)).not.toContain("{count}");
      }
    },
  );

  it("only appends browser and screen details, even on a URL containing secrets", (): void => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/156.0.0.0" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("location", {
      pathname: "/@private_handle",
      search: "?token=secret&email=private@example.test",
      hash: "#private",
    });
    expect(environment()).toBe("Browser: Chrome/156.0.0.0 · Screen: 390×844");
  });

  it.each(LOCALES.filter((locale: Locale): boolean => locale !== "en"))(
    "%s localizes failed requests without changing status or code",
    async (locale: Locale): Promise<void> => {
      await loadCatalog(locale);
      setLocaleSource((): Locale => locale);
      const error = new ApiError("English server detail", 429, "rate_limited");
      expect(errorMessage(error)).toBe(t("error.rateLimit"));
      expect(error).toMatchObject({ status: 429, code: "rate_limited" });
      expect(errorMessage(new TypeError("Failed to fetch"))).toBe(t("common.failed"));
      expect(errorMessage(new ApiError("Unexpected server detail", 502, null))).toBe(t("common.failed"));
      expect(errorMessage(new ApiError("Upload a logo first.", 400, "future_code"))).toBe(t("error.invalid"));
      expect(errorMessage(new ApiError("Only the owner can do this.", 403, null))).toBe(t("error.forbidden"));
      expect(errorMessage(new ApiError("Unknown client error.", 418, null))).toBe(t("common.failed"));
      const taken = new ApiError("This handle is already in use.", 409, "handle_taken");
      expect(errorMessage(taken)).toBe(t("error.handleTaken"));
      expect(errorText(taken)).toBe(t("error.handleTaken"));
      expect(ceremonyError(new ApiError("Add another key first.", 409, "last_key"))).toBe(t("keys.onlyKey"));
      expect(errorMessage(new ApiError("Fill in the template.", 400, "bug_template_empty"))).toBe(
        t("ideas.form.fillTemplate"),
      );
      expect(errorMessage(new ApiError("Invalid date.", 400, "invalid_schedule_date"))).toBe(t("error.scheduleDate"));
    },
  );

  it.each(LOCALES)("%s preserves actionable cooldown and moderation errors", async (locale: Locale): Promise<void> => {
    await loadCatalog(locale);
    setLocaleSource((): Locale => locale);
    const response: Response = errorResponse(
      new HttpError(409, "Wait before changing your handle.", "handle_cooldown", { retryAt: "2026-12-13" }),
    );
    const error: ApiError = apiError(response.status, await response.json(), "Failed");
    const date: string = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long", timeZone: "UTC" }).format(
      new Date("2026-12-13"),
    );
    expect(errorMessage(error)).toBe(t("error.handleCooldownDate", { date }));
    expect(errorMessage(error)).not.toBe(t("error.conflict"));
    expect(errorMessage(new ApiError("Frozen", 423, "page_frozen"))).toBe(t("error.pageFrozen"));
    expect(errorMessage(new ApiError("Suspended", 423, "page_suspended"))).toBe(t("error.pageSuspended"));
    expect(errorMessage(new ApiError("Locked", 423, null))).toBe(t("error.pageLocked"));
    expect(errorMessage(new ApiError("Cooldown", 409, "handle_cooldown", { retryAt: "invalid" }))).toBe(
      t("error.handleCooldown"),
    );
    expect(errorMessage(new ApiError("Approve enrollment", 403, "enrollment_required"))).toBe(
      t("keys.operatorApproval"),
    );
    expect(errorMessage(new ApiError("Enrollment unavailable", 503, "enrollment_unavailable"))).toBe(
      t("keys.enrollmentUnavailable"),
    );
    expect(errorMessage(new ApiError("Internal service detail", 503, "unknown_failure"))).toBe(t("common.failed"));
  });

  it("keeps actionable unmapped client errors in English", (): void => {
    expect(errorMessage(new ApiError("Upload a logo first.", 400, "future_code"))).toBe("Upload a logo first.");
  });

  it.each(LOCALES)(
    "%s localizes invalid binary labels from the schema boundary",
    async (locale: Locale): Promise<void> => {
      await loadCatalog(locale);
      setLocaleSource((): Locale => locale);
      const response: Response = await readJson(
        new Request("https://streambullets.test/api/streamers/host", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", kind: "binary", title: "Choose a side", options: ["Same", "same"] }),
        }),
        entryActionSchema,
      ).then(
        (): Response => new Response(null, { status: 200 }),
        (error: unknown): Response => errorResponse(error),
      );
      expect(response.status).toBe(400);
      const error: ApiError = apiError(response.status, await response.json(), "Failed");
      expect(error.code).toBe("binary_options_invalid");
      expect(errorMessage(error)).toBe(t("error.binaryOptions"));
      if (locale !== "en") expect(errorMessage(error)).not.toBe("Add two different poll options.");
    },
  );

  it("rejects client-supplied validation metadata", async (): Promise<void> => {
    const response: Response = await readJson(
      new Request("https://streambullets.test/api/streamers/host", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          kind: "binary",
          title: "Choose a side",
          params: { apiCode: "binary_options_invalid" },
        }),
      }),
      entryActionSchema,
    ).then(
      (): Response => new Response(null, { status: 200 }),
      (error: unknown): Response => errorResponse(error),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty("code");
  });

  it.each(LOCALES)("%s offers localized binary defaults", (locale: Locale): void => {
    const defaults: readonly [string, string] = binaryOptions(locale);
    expect(defaults).toHaveLength(2);
    if (locale !== "en") expect(defaults).not.toEqual(["Yes", "No"]);
    expect(
      entryActionSchema.safeParse({ action: "create", kind: "binary", title: "Choose a side", options: [...defaults] })
        .success,
    ).toBe(true);
  });

  it("accepts custom binary labels and rejects invalid pairs", (): void => {
    const input = { action: "create", kind: "binary", title: "Choose a side", options: ["Keep it", "Change it"] };
    expect(entryActionSchema.parse(input)).toMatchObject(input);
    expect(entryActionSchema.safeParse({ ...input, options: ["One", "Two", "Three"] }).success).toBe(false);
    expect(entryActionSchema.safeParse({ ...input, options: ["Same", "same"] }).success).toBe(false);
    expect(entryActionSchema.safeParse({ ...input, options: ["", "Other"] }).success).toBe(false);
    expect(entryActionSchema.safeParse({ ...input, options: undefined }).success).toBe(true);
  });
});
