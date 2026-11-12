import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage } from "../app/components/api";
import { ceremonyError, errorText } from "../app/components/admin/webauthn";
import { environment, switchTemplate } from "../app/components/ideas/idea-dialog";
import { LOCALES, intlLocale, loadCatalog, setLocaleSource, t, tn, type Locale } from "../app/i18n";
import { BUG_TEMPLATES } from "../app/lib/bug-templates";
import { isUntouchedTemplate } from "../app/lib/ideas";

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
    expect(errorMessage(new ApiError("Unknown reason", 400, "future_code"))).toBe(t("error.invalid"));
    const taken = new ApiError("This handle is already in use.", 409, "handle_taken");
    expect(errorMessage(taken)).toBe(t("error.handleTaken"));
    expect(errorText(taken)).toBe(t("error.handleTaken"));
    expect(ceremonyError(new ApiError("Add another key first.", 409, "last_key"))).toBe(t("keys.onlyKey"));
    expect(errorMessage(new ApiError("Fill in the template.", 400, "bug_template_empty"))).toBe(t("ideas.form.fillTemplate"));
    expect(errorMessage(new ApiError("Invalid date.", 400, "invalid_schedule_date"))).toBe(t("error.scheduleDate"));
  });
});
