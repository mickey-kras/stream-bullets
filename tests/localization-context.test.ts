import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiError, errorMessage } from "../app/components/api";
import { ceremonyError, errorText } from "../app/components/admin/webauthn";
import { environment, switchTemplate } from "../app/components/ideas/idea-dialog";
import { LOCALES, intlLocale, loadCatalog, setLocaleSource, t, tn, type Locale } from "../app/i18n";
import { BUG_TEMPLATES } from "../app/lib/bug-templates";
import { isUntouchedTemplate } from "../app/lib/ideas";
import { HttpError, errorResponse } from "../app/server/http.server";

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

  it.each(LOCALES)("%s offers a localized bug template and rejects an empty report", async (locale: Locale): Promise<void> => {
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
  });

  it("only appends browser and screen details, even on a URL containing secrets", (): void => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/156.0.0.0" });
    vi.stubGlobal("screen", { width: 390, height: 844 });
    vi.stubGlobal("location", { pathname: "/@private_handle", search: "?token=secret&email=private@example.test", hash: "#private" });
    expect(environment()).toBe("Browser: Chrome/156.0.0.0 · Screen: 390×844");
  });

  it.each(LOCALES.filter((locale: Locale): boolean => locale !== "en"))("%s localizes failed requests without changing status or code", async (locale: Locale): Promise<void> => {
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
    expect(errorMessage(new ApiError("Fill in the template.", 400, "bug_template_empty"))).toBe(t("ideas.form.fillTemplate"));
    expect(errorMessage(new ApiError("Invalid date.", 400, "invalid_schedule_date"))).toBe(t("error.scheduleDate"));
  });

  it.each(LOCALES)("%s preserves actionable cooldown and moderation errors", async (locale: Locale): Promise<void> => {
    await loadCatalog(locale);
    setLocaleSource((): Locale => locale);
    const response: Response = errorResponse(
      new HttpError(409, "Wait before changing your handle.", "handle_cooldown", {
        retryAt: "2026-12-13T08:30:00.000Z",
      }),
    );
    const body: unknown = await response.json();
    expect(body).toEqual({
      error: "Wait before changing your handle.",
      code: "handle_cooldown",
      details: { retryAt: "2026-12-13T08:30:00.000Z" },
    });
    const error: ApiError = apiError(response.status, body, "Failed");
    const date: string = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "long", timeZone: "UTC" }).format(
      new Date("2026-12-13"),
    );
    expect(errorMessage(error)).toBe(t("error.handleCooldownDate", { date }));
    expect(errorMessage(error)).toContain(date);
    expect(errorMessage(error)).not.toBe(t("error.conflict"));
    expect(errorMessage(new ApiError("Cooldown", 409, "handle_cooldown", { retryAt: "invalid" }))).toBe(
      t("error.handleCooldown"),
    );
    expect(errorMessage(new ApiError("Cooldown", 409, "handle_cooldown"))).toBe(t("error.handleCooldown"));
    expect(errorMessage(new ApiError("Frozen", 423, "page_frozen"))).toBe(t("error.pageFrozen"));
    expect(errorMessage(new ApiError("Suspended", 423, "page_suspended"))).toBe(t("error.pageSuspended"));
    expect(errorMessage(new ApiError("Locked", 423, null))).toBe(t("error.pageLocked"));
    expect(errorMessage(new ApiError("English server detail", 429, "rate_limited"))).toBe(t("error.rateLimit"));
    if (locale === "en") return;
    expect(errorMessage(new ApiError("Internal service detail", 503, "unknown_failure"))).toBe(t("common.failed"));
    expect(errorMessage(new ApiError("Not JSON", 200, null))).toBe(t("common.failed"));
  });

  // On main, English showed the server text for every API error. These cases must not get worse.
  it("keeps the English server text where the catalog text says less", (): void => {
    const stepUp: string = "Confirm with a key you already registered, then add the new key.";
    expect(errorMessage(new ApiError(stepUp, 403, "step_up_required"))).toBe(stepUp);
    expect(ceremonyError(new ApiError(stepUp, 403, "step_up_required"))).toBe(stepUp);
    const otherKey: string = "Confirm with a different key than the one you remove.";
    expect(errorMessage(new ApiError(otherKey, 403, "other_key_required"))).toBe(otherKey);
    expect(errorMessage(new ApiError("", 403, "step_up_required"))).toBe(t("keys.confirmTitle"));
    for (const text of ["Kick is unavailable.", "Characters are off on this server.", "Vote unavailable"]) {
      expect(errorMessage(new ApiError(text, 503, null))).toBe(text);
    }
    expect(errorMessage(new ApiError("This platform is not configured.", 503, "platform_unavailable"))).toBe(
      "This platform is not configured.",
    );
    expect(errorMessage(new ApiError("The request failed. Please try again.", 500, null))).toBe(t("common.failed"));
    expect(errorMessage(new ApiError("Admin request failed.", 200, null))).toBe("Admin request failed.");
    expect(errorMessage(new ApiError("", 502, null))).toBe(t("common.failed"));
  });

  it.each(LOCALES.filter((locale: Locale): boolean => locale !== "en"))(
    "%s still translates the security-key codes",
    async (locale: Locale): Promise<void> => {
      await loadCatalog(locale);
      setLocaleSource((): Locale => locale);
      expect(errorMessage(new ApiError("Confirm again.", 403, "step_up_required"))).toBe(t("keys.confirmTitle"));
      expect(errorMessage(new ApiError("Use another key.", 403, "other_key_required"))).toBe(t("keys.confirmRemove"));
    },
  );

  it("keeps actionable unmapped client errors in English", (): void => {
    expect(errorMessage(new ApiError("Upload a logo first.", 400, "future_code"))).toBe("Upload a logo first.");
    expect(errorMessage(new ApiError("Only the owner can do this.", 403, null))).toBe("Only the owner can do this.");
    expect(errorMessage(new ApiError("", 400, null))).toBe(t("common.failed"));
  });

  it("reads only string details from an error body and sends none without them", async (): Promise<void> => {
    const error: ApiError = apiError(
      409,
      { error: "Wait.", code: "x", details: { retryAt: "soon", count: 3 } },
      "Failed",
    );
    expect(error.details).toEqual({ retryAt: "soon" });
    expect(apiError(409, { error: "Wait.", details: "text" }, "Failed").details).toEqual({});
    expect(apiError(500, null, "Failed")).toMatchObject({ message: "Failed", code: null, details: {} });
    expect(await errorResponse(new HttpError(423, "Frozen.", "page_frozen")).json()).toEqual({
      error: "Frozen.",
      code: "page_frozen",
    });
    expect(await errorResponse(new HttpError(404, "Not found.")).json()).toEqual({ error: "Not found." });
  });
});
