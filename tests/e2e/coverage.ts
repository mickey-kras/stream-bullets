import {
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Disposable,
  type Frame,
  type Page,
} from "@playwright/test";
import { z } from "zod";
import { UI_COVERAGE_PREFIX, uiSnapshotSchema, writeUiSnapshot, type UiCoverage, type UiSnapshot } from "../../scripts/ui-coverage.ts";

export { expect } from "@playwright/test";
export type { APIRequestContext, Browser, BrowserContext, CDPSession, Page } from "@playwright/test";

export const COVERAGE_TRANSPORT = {
  binding: "__streambullets_save_coverage__",
  flush: "__streambullets_flush_coverage__",
  storage: "streambullets:ui-coverage:",
  prefix: UI_COVERAGE_PREFIX,
  origins: ["http://localhost:5173", "https://localhost:5174", "http://localhost:5175"],
} as const;
type InstallOptions = { binding: string; flush: string; storage: string; prefix: string; origins: readonly string[] };
const snapshotSchema = uiSnapshotSchema.extend({
  documentId: z.string().uuid(), sequence: z.number().int().positive(), final: z.literal(true),
}).refine((frame): boolean => frame.id === `${frame.documentId}:${frame.sequence}`);
const messageSchema = z.union([
  z.object({ kind: z.literal("start"), documentId: z.string().uuid(), sequence: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("failure"), documentId: z.string().uuid(), message: z.string() }),
  snapshotSchema,
]);

// Runs inside each document. Only by-value counters cross the binding; navigation never waits for Node.
export function installBrowserCoverage(options: InstallOptions): void {
  if (!options.origins.includes(location.origin)) return;
  const globals: Record<string, unknown> = globalThis as unknown as Record<string, unknown>;
  if (typeof globals[options.flush] === "function") return;
  const documentId: string = crypto.randomUUID();
  let sequence: number = 0;
  let failure: string | null = null;
  const deliver = async (key: string, payload: string): Promise<void> => {
    const binding: unknown = globals[options.binding];
    if (typeof binding !== "function") throw new Error("Browser coverage binding is unavailable.");
    await (binding as (value: string) => Promise<void>)(payload);
    if (sessionStorage.getItem(key) === payload) sessionStorage.removeItem(key);
  };
  const replay = async (): Promise<void> => {
    const keys: string[] = [];
    for (let index: number = 0; index < sessionStorage.length; index++) {
      const key: string | null = sessionStorage.key(index);
      if (key?.startsWith(options.storage)) keys.push(key);
    }
    for (const key of keys) {
      const payload: string | null = sessionStorage.getItem(key);
      if (payload !== null) await deliver(key, payload);
    }
  };
  const capture = (): { key: string; payload: string } => {
    const files: UiSnapshot["files"] = {};
    const originals: UiCoverage[] = [];
    for (const key of Object.keys(globals).filter((name: string): boolean => name.startsWith(options.prefix))) {
      const sourceHash: string = key.slice(options.prefix.length);
      if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("Browser coverage source identity is invalid.");
      const table: Record<string, UiCoverage> = globals[key] as Record<string, UiCoverage>;
      for (const [path, coverage] of Object.entries(table)) {
        if (files[path]) throw new Error("Browser coverage contains multiple versions of one source.");
        files[path] = { sourceHash, coverage: structuredClone(coverage) };
        originals.push(coverage);
      }
    }
    const id: string = `${documentId}:${++sequence}`;
    const key: string = `${options.storage}${id}`;
    const payload: string = JSON.stringify({ version: 1, id, documentId, sequence, final: true, files });
    // Save before resetting: a lost binding event is replayed by the next same-origin document.
    sessionStorage.setItem(key, payload);
    for (const coverage of originals) {
      for (const id of Object.keys(coverage.s)) coverage.s[id] = 0;
      for (const id of Object.keys(coverage.f)) coverage.f[id] = 0;
      for (const id of Object.keys(coverage.b)) coverage.b[id].fill(0);
    }
    return { key, payload };
  };
  const onHide = (): void => {
    try {
      const frame = capture();
      // Rejections retain the synchronous backup; the fixture also tracks Node-side failures.
      void deliver(frame.key, frame.payload).catch((): void => undefined);
    } catch {
      failure = "Browser coverage snapshot could not be stored.";
      const binding: unknown = globals[options.binding];
      if (typeof binding === "function") void (binding as (value: string) => Promise<void>)(
        JSON.stringify({ kind: "failure", documentId, message: failure }),
      ).catch((): void => undefined);
      throw new Error(failure);
    }
  };
  const flush = async (): Promise<void> => {
    if (failure) throw new Error(failure);
    await replay();
    const frame = capture();
    await deliver(frame.key, frame.payload);
    removeEventListener("pagehide", onHide);
    removeEventListener("DOMContentLoaded", onReady);
    removeEventListener("pageshow", onShow);
  };
  globals[options.flush] = Object.assign(flush, { documentId });
  const onReady = (): void => { void replay().catch((): void => undefined); };
  const startDocument = (): void => {
    const startKey: string = `${options.storage}${documentId}:start:${sequence}`;
    const start: string = JSON.stringify({ kind: "start", documentId, sequence });
    try {
      sessionStorage.setItem(startKey, start);
    } catch {
      failure = "Browser coverage document start could not be stored.";
      const binding: unknown = globals[options.binding];
      if (typeof binding === "function") void (binding as (value: string) => Promise<void>)(
        JSON.stringify({ kind: "failure", documentId, message: failure }),
      ).catch((): void => undefined);
      throw new Error(failure);
    }
    void deliver(startKey, start).catch((): void => undefined);
  };
  const onShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    startDocument();
    onReady();
  };
  startDocument();
  onReady();
  addEventListener("DOMContentLoaded", onReady, { once: true });
  addEventListener("pagehide", onHide);
  addEventListener("pageshow", onShow);
}

interface PageCoverage {
  pending: Promise<void>;
  seen: Set<string>;
  starts: Map<string, number>;
  completed: Map<string, number>;
  resources: Disposable[];
  closing?: Promise<void>;
}
const pages: Map<Page, PageCoverage> = new Map();

async function start(page: Page): Promise<void> {
  if (process.env.BROWSER_COVERAGE !== "1") return;
  const state: PageCoverage = { pending: Promise.resolve(), seen: new Set(), starts: new Map(), completed: new Map(), resources: [] };
  try {
    state.resources.push(await page.exposeBinding(COVERAGE_TRANSPORT.binding, (_source, payload: unknown): Promise<void> => {
      state.pending = state.pending.then(async (): Promise<void> => {
        if (typeof payload !== "string") throw new Error("Browser coverage payload must be JSON text.");
        const message = messageSchema.parse(JSON.parse(payload));
        if ("kind" in message) {
          if (message.kind === "failure") throw new Error(message.message);
          state.starts.set(message.documentId, Math.max(state.starts.get(message.documentId) ?? 0, message.sequence));
          return;
        }
        if (state.seen.has(message.id)) return;
        await writeUiSnapshot("coverage/browser/raw", message);
        state.seen.add(message.id);
        state.starts.set(message.documentId, Math.max(state.starts.get(message.documentId) ?? 0, message.sequence - 1));
        state.completed.set(message.documentId, Math.max(state.completed.get(message.documentId) ?? 0, message.sequence));
      });
      return state.pending;
    }));
    state.resources.push(await page.addInitScript(installBrowserCoverage, COVERAGE_TRANSPORT));
    await page.evaluate(installBrowserCoverage, COVERAGE_TRANSPORT);
    pages.set(page, state);
  } catch (error: unknown) {
    for (const resource of [...state.resources].reverse()) await resource.dispose();
    if (error instanceof Error && error.message.includes("Script execution is prohibited")) return;
    throw error;
  }
}

async function collect(page: Page): Promise<void> {
  const state: PageCoverage | undefined = pages.get(page);
  if (!state) return;
  state.closing ??= (async (): Promise<void> => {
    try {
      for (const frame of page.frames() as Frame[]) {
        const origin: string = new URL(frame.url()).origin;
        if (!COVERAGE_TRANSPORT.origins.some((allowed: string): boolean => allowed === origin)) continue;
        await frame.evaluate(async (name: string): Promise<void> => {
          const flush: unknown = Reflect.get(globalThis, name);
          if (typeof flush !== "function") throw new Error("Browser coverage transport is missing from an application document.");
          await (flush as () => Promise<void>)();
        }, COVERAGE_TRANSPORT.flush);
      }
      await state.pending;
      if ([...state.starts].some(([id, sequence]): boolean => (state.completed.get(id) ?? 0) <= sequence))
        throw new Error("Browser coverage is missing a document's final snapshot.");
    } finally {
      try {
        for (const resource of [...state.resources].reverse()) await resource.dispose();
      } finally {
        pages.delete(page);
      }
    }
  })();
  await state.closing;
}

export async function newPage(context: BrowserContext | Browser, options?: BrowserContextOptions): Promise<Page> {
  const page: Page = await context.newPage(options);
  await start(page);
  return page;
}

export async function close(target: BrowserContext | Page): Promise<void> {
  const targets: Page[] = "pages" in target ? target.pages() : [target];
  try {
    for (const page of targets) await collect(page);
  } finally {
    await target.close();
  }
}

export const test = base.extend<{ coverage: void }>({
  page: async ({ page }, use, testInfo): Promise<void> => {
    await start(page);
    await use(page);
    for (const error of testInfo.errors) console.error(error.message ?? error.value);
    await collect(page);
  },
  coverage: [async ({ browser: _browser }, use): Promise<void> => {
    await use();
    for (const page of pages.keys()) await collect(page);
  }, { auto: true }],
});
