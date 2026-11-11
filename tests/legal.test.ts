import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, createStaticHandler, RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { SignIn, SiteFooter } from "../app/components/common";
import { contactEmails, legal, type LegalDetails } from "../app/legal";
import Privacy, { loader as privacyLoader } from "../app/routes/privacy";
import Terms, { loader as termsLoader } from "../app/routes/terms";
import { legalLoader } from "../app/server/legal.server";
import { appContext, type AppEnv } from "../app/env";

function render(component: ComponentType, details: LegalDetails = legal): string {
  const Stub = createRoutesStub([{ id: "legal", path: "/", Component: component }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/"],
      hydrationData: { loaderData: { legal: details } },
    }),
  );
}

describe("legal links and consent", () => {
  it("asks for age and terms consent under the sign-in buttons", () => {
    const html: string = render(() => createElement(SignIn, { providers: ["google", "twitch"] }));
    expect(html).toContain("Continue with Google");
    expect(html).toContain(`By continuing, you confirm you are ${legal.minimumAge} or older and agree to the`);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });

  it("keeps a neutral message and the legal links when no provider is configured", () => {
    const html: string = render(() => createElement(SignIn, { providers: [] }));
    expect(html).toContain("Sign-in is turned off on this site for now.");
    expect(html).not.toContain("By continuing");
    expect(html).toContain('href="/terms"');
  });

  it("links the footer to privacy, terms, and reporting, and opens Contact as a dialog", () => {
    const html: string = render(() => createElement(SiteFooter));
    for (const href of ["/privacy", "/terms", "/terms#reporting"]) expect(html).toContain(`href="${href}"`);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Contact<\/button>/);
    expect(html).not.toContain("mailto:");
  });

  it("keeps privacy@ for the legal pages and support@ for general contact", () => {
    expect(legal.contactEmail).toBe("privacy@streambullets.com");
    expect(contactEmails).toEqual({ support: "support@streambullets.com", privacy: "privacy@streambullets.com" });
  });

  it("marks both legal pages as drafts exactly while placeholders remain", () => {
    for (const page of [Privacy, Terms]) {
      const html: string = render(page);
      expect(html.includes("Draft — operator details pending.")).toBe(true);
      expect(html).toContain(legal.operatorName);
      expect(html).toContain(legal.contactEmail);
    }
  });
});

const publicDetails = {
  operatorName: "Example Operator",
  operatorCountry: "Example Country",
  policyEffectiveDate: "2026-01-01",
};

function legalContext(value?: string): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, {
    env: { LEGAL_DETAILS: value } as AppEnv,
    nonce: "test",
    responseHeaders: new Headers(),
  });
  return context;
}

function loadDetails(value?: string): LegalDetails {
  const context = legalContext(value);
  const url = new URL("https://example.test/privacy");
  return legalLoader({ context, request: new Request(url), url, pattern: "/privacy", params: {} });
}

describe("runtime legal details", () => {
  it("keeps an unconfigured deployment visibly in draft", () => {
    expect(loadDetails()).toEqual(legal);
  });

  it("renders configured identity and date on both pages without a draft notice", () => {
    const details = loadDetails(JSON.stringify(publicDetails));
    expect(details).toEqual({ ...legal, ...publicDetails });
    for (const page of [Privacy, Terms]) {
      const html = render(page, details);
      for (const value of Object.values(publicDetails)) expect(html).toContain(value);
      expect(html).not.toContain("Draft — operator details pending.");
      expect(html).not.toContain("[OPERATOR NAME]");
    }
  });

  it("does not retain one request's identity in another request", () => {
    loadDetails(JSON.stringify(publicDetails));
    expect(loadDetails()).toEqual(legal);
  });

  it.each([
    "",
    "private-invalid-json",
    "null",
    "{}",
    JSON.stringify({ ...publicDetails, operatorName: " " }),
    JSON.stringify({ ...publicDetails, policyEffectiveDate: "2026-02-30" }),
    JSON.stringify({ ...publicDetails, privateField: "not-public" }),
  ])("returns a sanitized 503 through both legal routes (%#)", async (value: string) => {
    const handler = createStaticHandler([
      { id: "privacy", path: "/privacy", loader: privacyLoader },
      { id: "terms", path: "/terms", loader: termsLoader },
    ]);
    for (const route of ["privacy", "terms"]) {
      const result = await handler.query(new Request(`https://example.test/${route}`), {
        requestContext: legalContext(value),
      });
      if (result instanceof Response) throw new Error("Expected a route result, not a redirect.");
      expect(result.statusCode).toBe(503);
      expect(result.errors?.[route]).toMatchObject({
        status: 503,
        data: "Legal details are not configured correctly.",
      });
    }
  });
});
