import { readFile, readdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { afterAll, beforeAll, expect, it } from "vitest";
import { quotaDay } from "../app/lib/activity";
import {
  ADMISSION_BURST,
  ADMISSION_RATE,
  MAX_SOCKETS,
  MODERATION_BURST,
  SEEN_MAX,
  SNAPSHOT_SIZE,
  YOUTUBE_MIN_POLL_MS,
} from "../app/server/channel-ingest-limits";
import {
  ActivityHarness,
  CONSUMERS,
  percentiles,
  type ActivityClient,
  type Consumer,
  type Page,
} from "./helpers/activity-harness";
import type { IngestReport, WorkerReport } from "./helpers/activity-worker";
import { youtubeText } from "./helpers/channels";
import {
  COST_DRIVERS_PER_LIVE_HOUR,
  DROPPED_EVENTS_BELOW_ADMISSION,
  EVENT_LATENCY_P95_MS,
  FLOOD_EVENT_LATENCY_P95_MS,
  LOST_ADMITTED_EVENTS,
  MODERATION_LATENCY_P95_MS,
  PROVIDER_REQUESTS_PER_RECONNECT,
  RECONNECT_SNAPSHOT_P95_MS,
  STORAGE_BYTE_GROWTH_PER_LIVE_HOUR,
  STORAGE_ROW_GROWTH_PER_LIVE_HOUR,
  YOUTUBE_UNITS_PER_LIVE_HOUR,
} from "./helpers/load-targets";

/**
 * Load tests of the activity path in the isolated harness (docs/live-room-capacity.md): many quiet channels, one
 * viral channel, a reconnect burst and a stream of several hours. Each scenario adds one entry to the JSON report
 * and asserts the proposed targets of tests/helpers/load-targets.ts. `LIVE_CAPACITY=1` turns the file on.
 */

const enabled: boolean = process.env.LIVE_CAPACITY === "1";

const QUIET_CHANNELS = 100;
const QUIET_SECONDS = 6;
/** Two chat messages and one deletion for each quiet channel. */
const QUIET_EVENTS = 3;
/** The viral channel offers ten times the chat admission rate. */
const VIRAL_CHAT_PER_SECOND: number = 10 * ADMISSION_RATE;
const VIRAL_SECONDS = 5;
const VIRAL_CHAT: number = VIRAL_CHAT_PER_SECOND * VIRAL_SECONDS;
/** Fewer than the moderation burst: admission must pass each one, whatever the chat bucket holds. */
const VIRAL_DELETIONS = 100;
/** The deletions start after this many chat messages, when the chat bucket is empty. */
const VIRAL_FLOOD_START = 500;
const STREAM_HOURS = 4;
const STREAM_STEP_MS: number = YOUTUBE_MIN_POLL_MS;
const STEPS_PER_HOUR: number = 3_600_000 / STREAM_STEP_MS;
const YOUTUBE_MESSAGES_PER_POLL = 20;
/** One Twitch chat message and one deletion each minute of the stream. */
const STEPS_PER_MINUTE: number = 60_000 / STREAM_STEP_MS;

/** The quiet channels with their open sockets. The reconnect burst of each channel uses them again. */
interface Fleet {
  pages: Page[];
  clients: ActivityClient[];
  /** Provider subscriptions before a consumer connected. */
  subscriptions: number;
  /** Provider requests that the first consumers of the channels caused. */
  startRequests: number;
}

let harness: ActivityHarness;
let fleet: Fleet | null = null;
const reports: Record<string, unknown>[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve): void => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** Waits until a count stays the same for three checks in a row, and returns it. */
async function settled(read: () => number): Promise<number> {
  const deadline: number = performance.now() + 15_000;
  let last: number = read();
  let same = 0;
  while (same < 3) {
    if (performance.now() > deadline) throw new Error("The harness did not settle");
    await sleep(100);
    const next: number = read();
    same = next === last ? same + 1 : 0;
    last = next;
  }
  return last;
}

/** Runs `count` tasks with at most `limit` in flight. */
async function pooled<T>(count: number, limit: number, work: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) {
      const index: number = next++;
      results[index] = await work(index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
}

function received(clients: readonly ActivityClient[]): number {
  return clients.reduce(
    (sum: number, client: ActivityClient): number => sum + client.counts.chat + client.counts.moderation,
    0,
  );
}

/** Events of one type that did not reach a socket: the expected count of each socket minus what it received. */
function missing(clients: readonly ActivityClient[], type: "chat" | "moderation", expected: number): number {
  return clients.reduce((sum: number, client: ActivityClient): number => sum + expected - client.counts[type], 0);
}

async function pageReports(pages: readonly Page[]): Promise<IngestReport[]> {
  return pooled(pages.length, 20, (index: number): Promise<IngestReport> => harness.report(pages[index]));
}

type Counter = "requests" | "alarms" | "d1Statements" | "sockets" | "events";

function total(items: readonly IngestReport[], key: Counter): number {
  return items.reduce((sum: number, item: IngestReport): number => sum + item[key], 0);
}

/** Opens the given consumers on each page, at most 20 pages at a time. */
async function openClients(pages: readonly Page[], consumers: readonly Consumer[]): Promise<ActivityClient[]> {
  const groups: ActivityClient[][] = await pooled(pages.length, 20, (index: number) =>
    Promise.all(consumers.map((consumer: Consumer) => harness.listen(pages[index], consumer))),
  );
  return groups.flat();
}

/** The quiet channels, each with its four consumers. The first call makes them. */
async function openFleet(): Promise<Fleet> {
  if (fleet) return fleet;
  const pages: Page[] = [];
  for (let index = 0; index < QUIET_CHANNELS; index++) pages.push(await harness.addPage({ twitch: true }));
  const subscriptions: number = harness.providers.subscriptions.length;
  const callsBefore: number = harness.providerCalls();
  const clients: ActivityClient[] = await openClients(pages, CONSUMERS);
  // The first consumer of each channel starts one subscription check at the provider.
  const startRequests: number = (await settled((): number => harness.providerCalls())) - callsBefore;
  fleet = { pages, clients, subscriptions, startRequests };
  return fleet;
}

/** The sockets of the page that this harness calls viral: the owner, the dock and nine sources of each output. */
function viralConsumers(): Consumer[] {
  return Array.from(
    { length: MAX_SOCKETS },
    (_, index: number): Consumer => CONSUMERS[index < 2 ? index : 2 + (index % 2)],
  );
}

/**
 * The resident memory of the workerd process that this test started, in bytes. Null where `/proc` does not show
 * it (not Linux): the report then says that it has no value.
 */
async function runtimeResidentBytes(): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const parent = new RegExp(String.raw`^PPid:\s+${process.pid}$`, "m");
  for (const entry of entries.filter((name: string): boolean => /^\d+$/.test(name))) {
    // A process can end between the list and the read: its file is then gone.
    const status: string | null = await readFile(`/proc/${entry}/status`, "utf8").catch((): null => null);
    if (status === null || !/^Name:\s+workerd$/m.test(status) || !parent.test(status)) continue;
    const resident = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    return resident ? Number(resident[1]) * 1024 : null;
  }
  return null;
}

beforeAll(async (): Promise<void> => {
  if (!enabled) return;
  harness = await ActivityHarness.start();
  reports.push({
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
    },
  });
}, 60_000);

afterAll(async (): Promise<void> => {
  if (!enabled) return;
  try {
    console.log("ACTIVITY_CAPACITY_RESULTS", JSON.stringify(reports));
    const output: string | undefined = process.env.LIVE_CAPACITY_OUTPUT;
    if (output) await writeFile(output, JSON.stringify(reports, null, 2) + "\n");
  } finally {
    await harness?.dispose();
  }
});

it("serves many quiet channels without a dropped event", {
  skip: !enabled,
  timeout: 90_000,
}, async (): Promise<void> => {
  const { pages, clients, subscriptions, startRequests }: Fleet = await openFleet();
  const worker: WorkerReport = await harness.workerReport();
  const sends: Promise<number>[] = [];
  const events: number = QUIET_CHANNELS * QUIET_EVENTS;
  const started: number = performance.now();
  for (let index = 0; index < events; index++) {
    const page: Page = pages[index % QUIET_CHANNELS];
    const deletion: boolean = index >= QUIET_CHANNELS * (QUIET_EVENTS - 1);
    sends.push(
      deletion ? harness.remove(page, `quiet-${index % QUIET_CHANNELS}`) : harness.chat(page, `quiet-${index}`),
    );
    await sleep(started + ((index + 1) * QUIET_SECONDS * 1000) / events - performance.now());
  }
  const statuses: number[] = await Promise.all(sends);
  await settled((): number => received(clients));
  const dropped = {
    chat: missing(clients, "chat", QUIET_EVENTS - 1),
    moderation: missing(clients, "moderation", 1),
  };
  const latency = percentiles(clients.flatMap((client: ActivityClient): number[] => client.chatMs));
  const moderationLatency = percentiles(clients.flatMap((client: ActivityClient): number[] => client.moderationMs));
  const objects: IngestReport[] = await pageReports(pages);
  const workerAfter: WorkerReport = await harness.workerReport();
  reports.push({
    scenario: "quiet-channels",
    channels: QUIET_CHANNELS,
    sockets: clients.length,
    seconds: QUIET_SECONDS,
    sent: { chat: QUIET_CHANNELS * (QUIET_EVENTS - 1), moderation: QUIET_CHANNELS },
    dropped,
    chatLatencyMs: latency,
    moderationLatencyMs: moderationLatency,
    providerRequestsAtStart: startRequests,
    providerSubscriptions: { before: subscriptions, after: harness.providers.subscriptions.length },
    objectRequests: total(objects, "requests"),
    objectAlarmRuns: total(objects, "alarms"),
    objectD1Statements: total(objects, "d1Statements"),
    workerD1StatementsForEvents: workerAfter.d1Statements - worker.d1Statements,
  });
  expect(statuses.every((status: number): boolean => status === 204)).toBe(true);
  expect(dropped.chat).toBeLessThanOrEqual(DROPPED_EVENTS_BELOW_ADMISSION.chat);
  expect(dropped.moderation).toBeLessThanOrEqual(DROPPED_EVENTS_BELOW_ADMISSION.moderation);
  expect(latency.p95).toBeLessThanOrEqual(EVENT_LATENCY_P95_MS);
  expect(moderationLatency.p95).toBeLessThanOrEqual(EVENT_LATENCY_P95_MS);
  // Consumers add no provider subscription: each channel keeps the ones its connect made.
  expect(harness.providers.subscriptions).toHaveLength(subscriptions);
});

it("bounds one viral channel and never holds moderation back", {
  skip: !enabled,
  timeout: 90_000,
}, async (): Promise<void> => {
  const page: Page = await harness.addPage({ twitch: true });
  const clients: ActivityClient[] = await openClients([page], viralConsumers());
  await settled((): number => harness.providerCalls());
  // The channel is live before the flood: one message fills the caches of the Worker and the object.
  expect(await harness.chat(page, "viral-warm")).toBe(204);
  await settled((): number => received(clients));
  for (const client of clients) client.chatMs.length = 0;
  const sends: (() => Promise<number>)[] = [];
  for (let index = 0; index < VIRAL_CHAT; index++) {
    sends.push((): Promise<number> => harness.chat(page, `viral-${index}`));
    const deletion: number = (index - VIRAL_FLOOD_START) / 20;
    if (Number.isInteger(deletion) && deletion >= 0 && deletion < VIRAL_DELETIONS)
      sends.push((): Promise<number> => harness.remove(page, `viral-${deletion}`));
  }
  // Each delivery leaves at its time, whether the earlier ones are answered or not.
  const perSecond: number = sends.length / VIRAL_SECONDS;
  const pending: Promise<number>[] = [];
  const started: number = performance.now();
  while (pending.length < sends.length) {
    const due: number = Math.min(sends.length, Math.ceil(((performance.now() - started) / 1000) * perSecond));
    while (pending.length < due) pending.push(sends[pending.length]());
    await sleep(2);
  }
  const offeredSeconds: number = (performance.now() - started) / 1000;
  const statuses: number[] = await Promise.all(pending);
  const seconds: number = (performance.now() - started) / 1000;
  await settled((): number => received(clients));
  const object: IngestReport = await harness.report(page);
  // The object stores a message id for each admitted chat message and a row for each admitted deletion.
  const admitted = { chat: object.chatIds - 1, moderation: object.deleted };
  const lost: number = missing(clients, "chat", object.chatIds) + missing(clients, "moderation", admitted.moderation);
  const latency = percentiles(clients.flatMap((client: ActivityClient): number[] => client.chatMs));
  const moderationLatency = percentiles(clients.flatMap((client: ActivityClient): number[] => client.moderationMs));
  reports.push({
    scenario: "viral-channel",
    sockets: clients.length,
    seconds: Number(seconds.toFixed(2)),
    offeredChatPerSecond: Math.round(VIRAL_CHAT / offeredSeconds),
    sent: { chat: VIRAL_CHAT, moderation: VIRAL_DELETIONS },
    admitted,
    droppedByAdmission: { chat: VIRAL_CHAT - admitted.chat, moderation: VIRAL_DELETIONS - admitted.moderation },
    lostAfterAdmission: lost,
    chatLatencyMs: latency,
    moderationLatencyMs: moderationLatency,
    objectRequests: object.requests,
    objectD1Statements: object.d1Statements,
    snapshotRows: object.events,
  });
  // The webhook accepts each delivery: the object drops the excess, and the provider does not retry it.
  expect(statuses.every((status: number): boolean => status === 204)).toBe(true);
  // The chat bucket: its burst at once, then its rate. The flood is above it, so the object drops chat.
  expect(admitted.chat).toBeGreaterThanOrEqual(ADMISSION_BURST);
  expect(admitted.chat).toBeLessThanOrEqual(ADMISSION_BURST + Math.ceil(ADMISSION_RATE * seconds));
  expect(VIRAL_CHAT - admitted.chat).toBeGreaterThan(0);
  // The moderation bucket is separate: fewer deletions than its burst all pass while chat is dropped.
  expect(VIRAL_DELETIONS).toBeLessThanOrEqual(MODERATION_BURST);
  expect(VIRAL_DELETIONS - admitted.moderation).toBeLessThanOrEqual(DROPPED_EVENTS_BELOW_ADMISSION.moderation);
  expect(lost).toBeLessThanOrEqual(LOST_ADMITTED_EVENTS);
  expect(latency.p95).toBeLessThanOrEqual(FLOOD_EVENT_LATENCY_P95_MS);
  expect(moderationLatency.p95).toBeLessThanOrEqual(MODERATION_LATENCY_P95_MS);
  expect(object.events).toBeLessThanOrEqual(SNAPSHOT_SIZE);
  harness.closeClients(page);
});

/** Closes the sockets of the pages, opens them again at once, and checks one snapshot and no provider request each. */
async function reconnectBurst(scenario: string, pages: readonly Page[], consumers: readonly Consumer[]): Promise<void> {
  const before: IngestReport[] = await pageReports(pages);
  // The snapshot of a page has each message that its object stores.
  const stored = new Map<Page, number>(pages.map((page: Page, index: number) => [page, before[index].events]));
  const callsBefore: number = harness.providerCalls();
  for (const page of pages) harness.closeClients(page);
  const deadline: number = performance.now() + 15_000;
  while (total(await pageReports(pages), "sockets") > 0) {
    if (performance.now() > deadline) throw new Error("The sockets did not close");
    await sleep(50);
  }
  const started: number = performance.now();
  const clients: ActivityClient[] = await Promise.all(
    pages.flatMap((page: Page) => consumers.map((consumer: Consumer) => harness.listen(page, consumer))),
  );
  const burstMs: number = performance.now() - started;
  // A second snapshot or a late provider request would arrive in this time.
  await sleep(500);
  const after: IngestReport[] = await pageReports(pages);
  const providerRequests: number = harness.providerCalls() - callsBefore;
  const snapshot = percentiles(clients.map((client: ActivityClient): number => client.snapshotMs));
  reports.push({
    scenario,
    channels: pages.length,
    sockets: clients.length,
    burstMs: Number(burstMs.toFixed(2)),
    snapshotMs: snapshot,
    storedMessages: total(before, "events"),
    providerRequests,
    objectD1StatementsPerReconnect: Number(
      ((total(after, "d1Statements") - total(before, "d1Statements")) / clients.length).toFixed(2),
    ),
  });
  for (const client of clients) {
    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0].events).toHaveLength(stored.get(client.page) ?? -1);
  }
  expect(providerRequests / clients.length).toBeLessThanOrEqual(PROVIDER_REQUESTS_PER_RECONNECT);
  expect(snapshot.p95).toBeLessThanOrEqual(RECONNECT_SNAPSHOT_P95_MS);
  for (const page of pages) harness.closeClients(page);
}

it("answers a reconnect burst with one snapshot each and no provider request", {
  skip: !enabled,
  timeout: 90_000,
}, async (): Promise<void> => {
  // One page with each socket it can have and a full snapshot.
  const viral: Page = await harness.addPage({ twitch: true });
  const clients: ActivityClient[] = await openClients([viral], viralConsumers());
  await settled((): number => harness.providerCalls());
  await pooled(SNAPSHOT_SIZE + 20, 20, (index: number): Promise<number> => harness.chat(viral, `burst-${index}`));
  await settled((): number => received(clients));
  expect((await harness.report(viral)).events).toBe(SNAPSHOT_SIZE);
  await reconnectBurst("reconnect-burst-viral-channel", [viral], viralConsumers());
  // A deployment closes the sockets of each live channel at once.
  const { pages }: Fleet = await openFleet();
  fleet = null;
  await reconnectBurst("reconnect-burst-all-channels", pages, CONSUMERS);
});

/** A message id of the stream. Each id has the same length, so the stored bytes of each hour compare. */
function streamId(step: number, index: number): string {
  return `${String(step).padStart(6, "0")}-${String(index).padStart(3, "0")}`;
}

/** One page of YouTube live chat with new messages, as `liveChatMessages.list` returns it. */
function chatPage(
  step: number,
  at: number,
): { items: unknown[]; nextPageToken: string; pollingIntervalMillis: number } {
  const publishedAt: string = new Date(at).toISOString();
  return {
    items: Array.from({ length: YOUTUBE_MESSAGES_PER_POLL }, (_, index: number): unknown =>
      youtubeText(`stream-${streamId(step, index)}`, `UCviewer${index % 50}`, "hello chat", {}, publishedAt),
    ),
    nextPageToken: `page-${step}`,
    pollingIntervalMillis: 1_000,
  };
}

/** The counters that grow during the stream, read at one time. */
interface Counters {
  object: IngestReport;
  worker: WorkerReport;
  providerRequests: number;
  quotaUnits: number;
  socketMessages: number;
}

it("keeps storage and provider quota bounded over a stream of several hours", {
  skip: !enabled,
  timeout: 180_000,
}, async (): Promise<void> => {
  // The stream starts one minute into a YouTube quota day, so each run spends the units of one day.
  const start: number = quotaDay(Date.now() + 3_600_000).resetAt + 60_000;
  const { day } = quotaDay(start);
  const page: Page = await harness.addPage({ twitch: true, youtube: true, tokenExpiresAt: start + 3_600_000 });
  harness.providers.identity.youtube = { id: String(page.youtube), name: "Capacity Host" };
  const calls = harness.providers.calls;
  const polls = (from: number): number =>
    calls.slice(from).filter((call): boolean => call.url.pathname.endsWith("/liveChat/messages")).length;
  const sent = { youtube: 0, twitch: 0, deletions: 0 };
  const hours: Record<string, unknown>[] = [];
  let clients: ActivityClient[] = [];
  try {
    await harness.step(page, start);
    clients = await openClients([page], CONSUMERS);
    const counters = async (): Promise<Counters> => ({
      object: await harness.report(page),
      worker: await harness.workerReport(),
      providerRequests: calls.length,
      quotaUnits: await harness.quotaUnits(page, day),
      socketMessages: received(clients),
    });
    let previous: Counters = await counters();
    let rows = 0;
    let bytes = 0;
    let pageServed = true;
    for (let step = 0; step < STREAM_HOURS * STEPS_PER_HOUR; step++) {
      const at: number = start + step * STREAM_STEP_MS;
      // A page that no poll read yet stays for the next poll.
      if (pageServed) harness.providers.chatPages = [chatPage(step, at)];
      const callsBefore: number = calls.length;
      await harness.step(page, at);
      pageServed = polls(callsBefore) > 0;
      if (pageServed) sent.youtube += YOUTUBE_MESSAGES_PER_POLL;
      if (step % STEPS_PER_MINUTE === 0) {
        expect(await harness.chat(page, `stream-${streamId(step, 0)}`, at)).toBe(204);
        sent.twitch += 1;
      } else if (step % STEPS_PER_MINUTE === 1) {
        expect(await harness.remove(page, `stream-${streamId(step - 1, 0)}`, at)).toBe(204);
        sent.deletions += 1;
      }
      if ((step + 1) % STEPS_PER_HOUR !== 0) continue;
      await settled((): number => received(clients));
      const now: Counters = await counters();
      const hour: number = (step + 1) / STEPS_PER_HOUR;
      const hourRows: number = now.object.events + now.object.seen + now.object.deleted;
      const drivers = {
        d1Statements:
          now.object.d1Statements -
          previous.object.d1Statements +
          (now.worker.d1Statements - previous.worker.d1Statements),
        alarmRuns: now.object.alarms - previous.object.alarms,
        providerRequests: now.providerRequests - previous.providerRequests,
      };
      const quotaUnits: number = now.quotaUnits - previous.quotaUnits;
      hours.push({
        hour,
        rows: { snapshot: now.object.events, seen: now.object.seen, deleted: now.object.deleted },
        rowGrowth: hour === 1 ? null : hourRows - rows,
        databaseBytes: now.object.databaseBytes,
        databaseByteGrowth: hour === 1 ? null : now.object.databaseBytes - bytes,
        runtimeResidentBytes: await runtimeResidentBytes(),
        youtubeQuotaUnits: quotaUnits,
        ...drivers,
        objectRequests: now.object.requests - previous.object.requests,
        socketMessages: now.socketMessages - previous.socketMessages,
      });
      expect(now.object.events).toBeLessThanOrEqual(SNAPSHOT_SIZE);
      expect(now.object.seen).toBeLessThanOrEqual(SEEN_MAX);
      expect(now.object.deleted).toBeLessThanOrEqual(SEEN_MAX);
      if (hour > 1) {
        expect(hourRows - rows).toBeLessThanOrEqual(STORAGE_ROW_GROWTH_PER_LIVE_HOUR);
        expect(now.object.databaseBytes - bytes).toBeLessThanOrEqual(STORAGE_BYTE_GROWTH_PER_LIVE_HOUR);
      }
      expect(quotaUnits).toBeLessThanOrEqual(YOUTUBE_UNITS_PER_LIVE_HOUR);
      expect(drivers.d1Statements).toBeLessThanOrEqual(COST_DRIVERS_PER_LIVE_HOUR.d1Statements);
      expect(drivers.alarmRuns).toBeLessThanOrEqual(COST_DRIVERS_PER_LIVE_HOUR.alarmRuns);
      expect(drivers.providerRequests).toBeLessThanOrEqual(COST_DRIVERS_PER_LIVE_HOUR.providerRequests);
      rows = hourRows;
      bytes = now.object.databaseBytes;
      previous = now;
    }
    const dropped = {
      chat: missing(clients, "chat", sent.youtube + sent.twitch),
      moderation: missing(clients, "moderation", sent.deletions),
    };
    reports.push({
      scenario: "stream-of-several-hours",
      hours: STREAM_HOURS,
      sockets: clients.length,
      sent,
      chatPerSecond: Number(((sent.youtube + sent.twitch) / (STREAM_HOURS * 3600)).toFixed(2)),
      dropped,
      youtubeStatus: await harness.connectionStatus(page, "youtube"),
      perHour: hours,
    });
    expect(dropped.chat).toBeLessThanOrEqual(DROPPED_EVENTS_BELOW_ADMISSION.chat);
    expect(dropped.moderation).toBeLessThanOrEqual(DROPPED_EVENTS_BELOW_ADMISSION.moderation);
  } finally {
    // The other objects of the runtime get real time back.
    await harness.step(page, null);
  }
});
