import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { exportAccount } from "../app/server/account.server";
import { getEntry, getOverlaySnapshot, getStreamer, listEntries, mutateEntry } from "../app/server/data.server";
import { LIVE_POLLS_SQL, livePolls, type PollRow } from "../app/server/live-polls";
import { listReports, submitReport } from "../app/server/reports.server";
import { createTestDatabase, type TestDatabase } from "./helpers/database";

let database: TestDatabase;
let env: AppEnv;
let pollId: string;

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = {
    DB: database.db,
    IMAGES: database.bucket,
    APP_ORIGIN: "https://stream.example.test",
    ADMIN_EMAILS: "host@example.test",
  } as AppEnv;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
      ('host','Host','host@example.test',1,1,1),('fan','Fan','fan@example.test',1,1,1)`),
    env.DB.prepare("INSERT INTO streamers (id,owner_id,handle,name) VALUES ('page','host','host_page','Host')"),
  ]);
  const poll = await mutateEntry(env, "host", "page", { action: "create", kind: "binary", title: "Continue?" });
  pollId = poll.id;
  // Simulate a later writer storing labels that reverse the legacy Yes/No order.
  await env.DB.prepare("UPDATE entries SET binary_labels=? WHERE id=?").bind('["No","Yes"]', pollId).run();
  await mutateEntry(env, "fan", "page", { action: "vote", id: pollId, choice: 0 });
});

afterAll(async (): Promise<void> => database.dispose());

describe("binary label reader compatibility", (): void => {
  it("preserves labels and vote indexes in board, detail, and overlay reads", async (): Promise<void> => {
    const streamer = await getStreamer(env, "host_page");
    if (!streamer) throw new Error("The seeded page is missing.");
    expect(await getEntry(env, pollId, "fan")).toMatchObject({
      options: ["No", "Yes"],
      myVote: 0,
      counts: null,
      total: 1,
    });
    const board = await listEntries(env, streamer, "fan", { kind: "polls" });
    expect(board.entries.find((entry) => entry.id === pollId)).toMatchObject({ options: ["No", "Yes"], myVote: 0 });
    const overlay = await getOverlaySnapshot(env, "page", pollId);
    expect(overlay.polls[0]).toMatchObject({ id: pollId, options: ["No", "Yes"], counts: null, total: 1 });
    const rows = await env.DB.prepare(LIVE_POLLS_SQL).bind("page", "page").all<PollRow>();
    expect(livePolls(rows.results)[0]).toMatchObject({ id: pollId, options: ["No", "Yes"], counts: null, total: 1 });
  });

  it("exports the labels that the owner and voter actually saw", async (): Promise<void> => {
    const owner = await exportAccount(env, "host");
    expect(owner.entries.find((entry) => entry.id === pollId)).toMatchObject({ options: ["No", "Yes"] });
    const voter = await exportAccount(env, "fan");
    expect(voter.votes.find((vote) => vote.entryId === pollId)).toMatchObject({ choice: 0, option: "No" });
  });

  it("keeps the displayed labels in moderation snapshots", async (): Promise<void> => {
    await submitReport(env, "fan", { targetKind: "entry", targetId: pollId, reason: "spam", details: "" });
    const queue = await listReports(env, "host", {});
    expect(queue.reports.find((report) => report.targetId === pollId)).toMatchObject({
      snapshot: "Continue?\n\nOptions: No · Yes",
    });
  });

  it("keeps canonical options compatible while writing custom labels", async (): Promise<void> => {
    const created = await mutateEntry(env, "host", "page", {
      action: "create",
      kind: "binary",
      title: "Another poll?",
      options: ["Custom one", "Custom two"],
    });
    const row = await env.DB.prepare("SELECT options,binary_labels FROM entries WHERE id=?").bind(created.id).first();
    expect(row).toEqual({ options: '["Yes","No"]', binary_labels: '["Custom one","Custom two"]' });
    expect(await getEntry(env, created.id, null)).toMatchObject({ options: ["Custom one", "Custom two"] });
  });
});
