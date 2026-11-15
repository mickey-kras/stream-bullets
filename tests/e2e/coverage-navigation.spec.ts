import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { uiSnapshotSchema, type UiSnapshot } from "../../scripts/ui-coverage.ts";
import { COVERAGE_TRANSPORT, close, expect, newPage, test } from "./coverage";
import { accounts, origin } from "./fixtures";

for (const mocked of [false, true]) {
  test(`browser coverage preserves old-document handlers before a ${mocked ? "mocked redirect" : "full navigation"}`, async ({ browser }) => {
    test.skip(process.env.BROWSER_COVERAGE !== "1", "Requires browser coverage collection.");
    const directory: string = "coverage/browser/raw";
    const before: Set<string> = new Set(await readdir(directory).catch((error: unknown): string[] => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }));
    // This spec owns TEST-NET-3 addresses .250 and .251.
    const context = await browser.newContext({ baseURL: origin, extraHTTPHeaders: {
      "CF-Connecting-IP": `203.0.113.${mocked ? 251 : 250}`, Origin: origin,
    } });
    const owner = (await accounts()).owner;
    await context.addCookies([{
      name: "stream-bullets.session_token", value: owner.cookie, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax",
    }]);
    const page = await newPage(context);
    const redirect: string = "https://coverage-navigation.example.test/authorize";
    if (mocked) await page.route(redirect, (route) => route.fulfill({ status: 302, headers: { location: `${origin}/streamers` }, body: "" }));
    await page.goto("/streamers?dialog=data");
    const documentId: string = await page.evaluate((name: string): string => {
      const flush: unknown = Reflect.get(globalThis, name);
      if (typeof flush !== "function") throw new Error("Browser coverage transport is unavailable.");
      const id: unknown = Reflect.get(flush, "documentId");
      if (typeof id !== "string") throw new Error("Browser coverage document identity is unavailable.");
      return id;
    }, COVERAGE_TRANSPORT.flush);
    const data = page.getByRole("dialog", { name: "Your data", exact: true });
    await expect(data).toBeVisible();
    await data.getByRole("button", { name: "Delete my account", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete your account?", exact: true });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("textbox", { name: "Type DELETE to confirm" }).fill("DELETE");
    await expect(confirmation.getByRole("button", { name: "Delete my account", exact: true })).toBeEnabled();
    await page.goto(mocked ? redirect : "/streamers");
    await expect(page).toHaveURL(/\/streamers$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await close(context);
    const files: string[] = (await readdir(directory)).filter((file: string): boolean => file.endsWith(".json") && !before.has(file));
    const segments: UiSnapshot[] = await Promise.all(files.map(async (file: string): Promise<UiSnapshot> =>
      uiSnapshotSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8"))),
    ));
    const observed = segments.filter((frame): boolean => frame.id.startsWith(`${documentId}:`)).flatMap((frame) => {
      const file = frame.files["app/components/account/data-dialog.tsx"];
      if (!file) return [];
      return Object.entries(file.coverage.fnMap).filter(([, value]): boolean =>
        typeof value === "object" && value !== null && "name" in value && value.name === "DataDialog",
      ).map(([id]): number => file.coverage.f[id]);
    });
    expect(observed.some((count: number): boolean => count > 0)).toBe(true);
  });
}
