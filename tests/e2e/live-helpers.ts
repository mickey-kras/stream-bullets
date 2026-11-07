import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext } from "@playwright/test";
import { z } from "zod";

export const origin: string = "http://localhost:5173";
/** Screenshots for the Phase 5 review. Set P5_SHOTS to a folder to save them. */
export const shots: string | undefined = process.env.P5_SHOTS;
const sessionSchema = z.record(z.string(), z.object({ id: z.string().uuid(), cookie: z.string().min(1) }));

/** A browser context signed in as one of the seeded test accounts, with its own client IP. */
export async function signedIn(browser: Browser, role: string, ip: number): Promise<BrowserContext> {
  const sessions = sessionSchema.parse(JSON.parse(await readFile(".wrangler/e2e/sessions.json", "utf8")));
  const session = sessions[role];
  if (!session) throw new Error("Unknown test account.");
  const context = await browser.newContext({
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

const boardSchema = z.object({ entries: z.array(z.object({ id: z.string(), kind: z.string(), title: z.string() })) });

/** The id of the seeded Mash Battle on the feature page. */
export async function mashId(context: BrowserContext): Promise<string> {
  const board = boardSchema.parse(await (await context.request.get("/api/streamers/feature_host?kind=polls")).json());
  const battle = board.entries.find((entry) => entry.kind === "mash");
  if (!battle) throw new Error("Missing seeded Mash Battle.");
  return battle.id;
}
