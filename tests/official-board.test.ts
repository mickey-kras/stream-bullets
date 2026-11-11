import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppEnv } from "../app/env";
import { deleteAccount } from "../app/server/account.server";
import { getOwnStreamer, getVisibleStreamer, saveStreamer } from "../app/server/data.server";
import { setEntryStatus, setOfficial } from "../app/server/moderation.server";
import type { AdminSession } from "../app/server/stepup.server";
import { OFFICIAL_BOARD_ID, SYSTEM_USER_ID } from "../app/lib/system";
import { applyMigrations, createTestDatabase, migrationFiles, type TestDatabase } from "./helpers/database";

let database: TestDatabase;
let env: AppEnv;
const admin: AdminSession = {
  viewer: { id: "admin", name: "Admin", avatar: null, avatarPreset: null, locale: null, displayPrefs: null },
  sessionId: "admin-session",
  stepUp: "fresh",
};

beforeAll(async (): Promise<void> => {
  database = await createTestDatabase();
  env = { DB: database.db, IMAGES: database.bucket, ADMIN_EMAILS: "admin@example.test" } as AppEnv;
  await env.DB.prepare(
    "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('admin','Admin','admin@example.test',1,0,0)",
  ).run();
});
afterAll(async (): Promise<void> => database.dispose());

describe("seeded official Ideas board", (): void => {
  it("is public before anyone signs in and leaves the admin's personal profile slot free", async (): Promise<void> => {
    expect(await getVisibleStreamer(env, "streambullets", null)).toMatchObject({
      id: OFFICIAL_BOARD_ID,
      isOfficial: true,
      ownerId: SYSTEM_USER_ID,
    });
    expect(await getOwnStreamer(env, "admin")).toBeNull();
    expect(await saveStreamer(env, "admin", { handle: "personal", name: "Personal", about: "" })).toMatchObject({
      handle: "personal",
      ownerId: "admin",
    });
  });

  it("rejects authentication accounts and sessions for the system principal", async (): Promise<void> => {
    await expect(
      env.DB.prepare(
        "INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES ('system-account','external','google',?,0,0)",
      )
        .bind(SYSTEM_USER_ID)
        .run(),
    ).rejects.toThrow("cannot sign in");
    await expect(
      env.DB.prepare(
        "INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('system-session','token',?,9999999999999,0,0)",
      )
        .bind(SYSTEM_USER_ID)
        .run(),
    ).rejects.toThrow("cannot sign in");
    expect(
      await env.DB.prepare("SELECT email,email_verified FROM user WHERE id=?").bind(SYSTEM_USER_ID).first(),
    ).toEqual({ email: "", email_verified: 0 });
  });

  it("lets admins manage ideas and prevents removing the official designation", async (): Promise<void> => {
    const idea = "00000000-0000-4000-8000-000000000003";
    await env.DB.prepare(
      "INSERT INTO entries (id,streamer_id,author_id,kind,title,category,created_at) VALUES (?,?,'admin','topic','Improve search','feature',0)",
    )
      .bind(idea, OFFICIAL_BOARD_ID)
      .run();
    expect(await setEntryStatus(env, admin, idea, { status: "planned" })).toMatchObject({ status: "planned" });
    await expect(setOfficial(env, admin, OFFICIAL_BOARD_ID, { official: false })).rejects.toThrow(
      "must remain official",
    );
    await expect(
      env.DB.prepare("UPDATE streamers SET handle='renamed' WHERE id=?").bind(OFFICIAL_BOARD_ID).run(),
    ).rejects.toThrow("identity cannot change");
    await expect(deleteAccount(env, SYSTEM_USER_ID)).rejects.toThrow("cannot be deleted");
  });

  it("survives deletion of an administrator and their personal profile", async (): Promise<void> => {
    await deleteAccount(env, "admin");
    expect(await getVisibleStreamer(env, "streambullets", null)).toMatchObject({ id: OFFICIAL_BOARD_ID });
    expect(await getOwnStreamer(env, "admin")).toBeNull();
  });

  it("fails on an existing reserved handle without changing its owner or content", async (): Promise<void> => {
    const existing = await createTestDatabase({ migrate: false });
    try {
      const files = await migrationFiles();
      await applyMigrations(existing.db, files.filter((file: string): boolean => file < "0020"));
      await existing.db
        .prepare(
          "INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('existing','Existing','existing@example.test',0,0)",
        )
        .run();
      await existing.db
        .prepare(
          "INSERT INTO streamers (id,owner_id,handle,name) VALUES ('existing-page','existing','streambullets','Existing')",
        )
        .run();
      await expect(applyMigrations(existing.db, ["0020_official_board.sql"])).rejects.toThrow(
        "UNIQUE constraint failed",
      );
      expect(
        await existing.db
          .prepare("SELECT owner_id,name,is_official FROM streamers WHERE handle='streambullets'")
          .first(),
      ).toEqual({ owner_id: "existing", name: "Existing", is_official: 0 });
    } finally {
      await existing.dispose();
    }
  });
});
