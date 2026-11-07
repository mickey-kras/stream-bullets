import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser, BrowserContext, BrowserContextOptions } from "@playwright/test";
import { z } from "zod";

export const origin: string = "http://localhost:5173";
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

/** The seeded account ids by role (see tests/e2e-server.ts). */
export async function accounts(): Promise<Record<string, { id: string; cookie: string }>> {
  return sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
}

/** A browser context signed in as a seeded role. Each spec uses its own IP block for the rate limiter. */
export async function signedIn(
  browser: Browser,
  role: string,
  ip: number,
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const session = (await accounts())[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
    ...options,
    baseURL: origin,
    extraHTTPHeaders: { "CF-Connecting-IP": `192.0.2.${ip}`, Origin: origin },
  });
  await context.addCookies([
    {
      name: "stream-bullets.session_token",
      value: session.cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

/** Runs SQL against the e2e database, for data the UI cannot create quickly. */
export async function runSql(name: string, statements: string[]): Promise<void> {
  const path: string = resolve(`.wrangler/e2e/${name}.sql`);
  await writeFile(path, statements.join("\n"));
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "DB",
      "--local",
      "--config",
      resolve(".wrangler/e2e/wrangler.json"),
      "--env-file",
      resolve(".wrangler/e2e/.env"),
      "--persist-to",
      resolve(".wrangler/e2e/state"),
      "--file",
      path,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
}

/** A local calendar date `days` from today, as the date input wants it. */
export function dateFromToday(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
