import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { checkpointNavigation, close, expect, newPage, test } from "./coverage";
import { origin } from "./fixtures";

const rawCoverageSchema = z.array(z.object({
  url: z.string(),
  functions: z.array(z.object({
    functionName: z.string(),
    ranges: z.array(z.object({ count: z.number() })),
  })),
}));

for (const mocked of [false, true]) {
  test(`browser coverage preserves executed functions before a ${mocked ? "mocked redirect" : "full navigation"}`, async ({ browser }) => {
    test.skip(process.env.BROWSER_COVERAGE !== "1", "Requires browser coverage collection.");
    const directory: string = "coverage/browser/raw";
    const before: Set<string> = new Set(await readdir(directory).catch((error: unknown): string[] => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }));
    const context = await browser.newContext({ baseURL: origin });
    const page = await newPage(context);
    const probe: string = `/assets/coverage-navigation-probe.js?run=${randomUUID()}`;
    await page.route(`**${probe}`, (route) => route.fulfill({
      contentType: "application/javascript",
      body: "window.coverageNavigationProbe = function coverageNavigationProbe() { return 42; };",
    }));
    if (mocked) await page.route("**/coverage-navigation-redirect", async (route): Promise<void> => {
      await checkpointNavigation(page, () => route.fulfill({ status: 302, headers: { location: `${origin}/streamers` }, body: "" }));
    });
    await page.goto("/");
    await page.addScriptTag({ url: probe });
    expect(await page.evaluate((): number => (
      window as unknown as { coverageNavigationProbe: () => number }
    ).coverageNavigationProbe())).toBe(42);
    await page.goto(mocked ? "/coverage-navigation-redirect" : "/streamers");
    await expect(page).toHaveURL(/\/streamers$/);
    await close(context);
    const files: string[] = (await readdir(directory)).filter((file: string): boolean => file.endsWith(".json") && !before.has(file));
    const segments: z.infer<typeof rawCoverageSchema>[] = await Promise.all(files.map(async (file: string): Promise<z.infer<typeof rawCoverageSchema>> =>
      rawCoverageSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8"))),
    ));
    const probes = segments.flat().filter((entry): boolean => entry.url === `${origin}${probe}`);
    expect(probes.flatMap((entry) => entry.functions)
      .filter((fn): boolean => fn.functionName === "coverageNavigationProbe")
      .flatMap((fn) => fn.ranges).some((range): boolean => range.count > 0)).toBe(true);
  });
}
