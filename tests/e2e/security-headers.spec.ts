import { expect, test } from "./coverage";

test("JSON-LD remains readable under the production CSP on page loads and navigation", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent): void => {
      if (event.effectiveDirective !== "script-src-elem") return;
      document.documentElement.dataset.cspViolations = JSON.stringify([
        ...JSON.parse(document.documentElement.dataset.cspViolations ?? "[]") as string[],
        event.effectiveDirective,
      ]);
    });
  });
  for (const path of ["/", "/@feature_host"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    const policy: string = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("script-src 'self' 'nonce-");
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    const scripts = page.locator('script[type="application/ld+json"]');
    const blocks: Record<string, unknown>[] = (await scripts.allTextContents()).map(
      (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>,
    );
    if (path === "/") {
      expect(blocks).toContainEqual(expect.objectContaining({ "@graph": expect.any(Array) }));
    } else {
      expect(blocks).toContainEqual(expect.objectContaining({ "@type": "Person", alternateName: "@feature_host" }));
      expect(blocks).toContainEqual(expect.objectContaining({ "@type": "Event", name: "Mic shootout" }));
      await page.locator("button.topic").filter({ hasText: "Mic shootout" }).click();
      await expect.poll(async (): Promise<Record<string, unknown>[]> =>
        (await scripts.allTextContents()).map((text: string): Record<string, unknown> =>
          JSON.parse(text) as Record<string, unknown>,
        ),
      ).toContainEqual(expect.objectContaining({ "@type": "DiscussionForumPosting", headline: "Mic shootout" }));
    }
    expect(await page.locator("html").getAttribute("data-csp-violations")).toBeNull();
    // Positive control: the same document blocks executable inline scripts.
    await page.evaluate((): void => {
      const script: HTMLScriptElement = document.createElement("script");
      script.textContent = "document.documentElement.dataset.cspBypassed = 'yes'";
      document.head.appendChild(script);
    });
    await expect(page.locator("html")).toHaveAttribute("data-csp-violations", '["script-src-elem"]');
    expect(await page.locator("html").getAttribute("data-csp-bypassed")).toBeNull();
  }
});
