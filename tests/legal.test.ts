import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { SignIn, SiteFooter } from "../app/components/common";
import { contactEmails, legal, legalPlaceholdersRemain } from "../app/legal";
import Privacy from "../app/routes/privacy";
import Terms from "../app/routes/terms";

function render(component: ComponentType): string {
  const Stub = createRoutesStub([{ path: "/", Component: component }]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/"] }));
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
      expect(html.includes("Draft — operator details pending.")).toBe(legalPlaceholdersRemain);
      expect(html).toContain(legal.operatorName);
      expect(html).toContain(legal.contactEmail);
    }
  });
});
