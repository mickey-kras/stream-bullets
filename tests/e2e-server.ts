import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { makeSignature } from "better-auth/crypto";

interface BuildConfig {
  main: string;
  assets?: { directory: string; [key: string]: unknown };
  d1_databases: { binding: string; database_name: string; database_id?: string; migrations_dir?: string }[];
  [key: string]: unknown;
}

const root: string = process.cwd();
const directory: string = resolve(root, ".wrangler/e2e");
const buildPath: string = resolve(root, "build/server/wrangler.json");
const build: BuildConfig = JSON.parse(await readFile(buildPath, "utf8")) as BuildConfig;
if (!build.main || !Array.isArray(build.d1_databases) || build.d1_databases.length !== 1)
  throw new Error("Build the application before browser tests.");
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const secret: string = randomBytes(32).toString("hex");
const databaseId: string = randomUUID();
const config: BuildConfig = {
  ...build,
  main: resolve(dirname(buildPath), build.main),
  ...(build.assets
    ? { assets: { ...build.assets, directory: resolve(dirname(buildPath), build.assets.directory) } }
    : {}),
  vars: { APP_ORIGIN: "http://localhost:5173", ADMIN_EMAILS: "admin@example.test" },
  d1_databases: build.d1_databases.map((database) => ({
    ...database,
    database_id: databaseId,
    migrations_dir: resolve(root, "drizzle"),
  })),
};
const configPath: string = resolve(directory, "wrangler.json");
const statePath: string = resolve(directory, "state");
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await writeFile(resolve(directory, ".env"), `BETTER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
const wrangler: string = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const common: string[] = ["--config", configPath, "--env-file", resolve(directory, ".env")];
function execute(args: string[]): void {
  const result = spawnSync(process.execPath, [wrangler, ...args, ...common], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local test setup failed with exit ${result.status}.`);
}
execute(["d1", "migrations", "apply", "DB", "--local", "--persist-to", statePath]);
const now: number = Date.now();
const users: Record<string, { id: string; cookie: string }> = {};
const statements: string[] = [];
for (const role of [
  "owner",
  "viewer",
  "newcomer",
  "otherowner",
  "paginationowner",
  "admin",
  "leaver",
  "reporter",
  "frozenowner",
  "suspendedowner",
  "officialowner",
  "featureowner",
]) {
  const id: string = randomUUID();
  const token: string = randomBytes(24).toString("hex");
  users[role] = { id, cookie: encodeURIComponent(`${token}.${await makeSignature(token, secret)}`) };
  statements.push(
    `INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('${id}','${role}','${role}@example.test',1,${now},${now});`,
  );
  statements.push(
    `INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('${randomUUID()}','${token}','${id}',${now + 86_400_000},${now},${now});`,
  );
}
const streamId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${streamId}','${users.owner.id}','test_host','Test host','A test community.',0);`,
);
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${randomUUID()}','${users.otherowner.id}','other_host','Other host','Another test community.',0);`,
);
const paginationStreamId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${paginationStreamId}','${users.paginationowner.id}','pagination_host','Pagination host','A community with older entries.',0);`,
);
for (let index: number = 1; index <= 55; index += 1) {
  statements.push(
    `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${randomUUID()}','${paginationStreamId}','${users.paginationowner.id}','topic','Archive topic ${String(index).padStart(2, "0")}','An older conversation.','Tech & setups','[]',${now + index},0);`,
  );
}
// The leaver deletes their account in the browser tests: a page they own, and a comment with someone else's reply.
const leaverCommentId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${randomUUID()}','${users.leaver.id}','leaver_host','Leaver host','A community that is closing.',0);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) SELECT '${randomUUID()}',id,'${users.otherowner.id}','topic','Leaver discussion','','','[]',${now},0 FROM streamers WHERE handle='other_host';`,
  `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at) SELECT '${leaverCommentId}',id,'${users.leaver.id}','Leaver comment',${now} FROM entries WHERE title='Leaver discussion';`,
  `INSERT INTO entry_comments(id,entry_id,author_id,text,created_at,parent_id) SELECT '${randomUUID()}',id,'${users.viewer.id}','Reply that stays',${now + 1},'${leaverCommentId}' FROM entries WHERE title='Leaver discussion';`,
);
// Profile settings from migration 0006. The viewer picked a preset avatar, a language and display preferences.
statements.push(
  `UPDATE user SET avatar_preset=3, locale='en', display_prefs='{"contrast":"high","text":"115"}' WHERE id='${users.viewer.id}';`,
);
// Moderated pages (item 25): a frozen page stays public and read-only; a suspended page is hidden.
const frozenStreamId: string = randomUUID();
const suspendedStreamId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision,status,status_reason,status_changed_at,status_changed_by) VALUES ('${frozenStreamId}','${users.frozenowner.id}','frozen_host','Frozen host','A frozen community.',0,'frozen','Under review',${now},'${users.admin.id}');`,
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision,status,status_reason,status_changed_at,status_changed_by) VALUES ('${suspendedStreamId}','${users.suspendedowner.id}','suspended_host','Suspended host','A suspended community.',0,'suspended','Repeated spam',${now},'${users.admin.id}');`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${randomUUID()}','${frozenStreamId}','${users.viewer.id}','topic','Frozen topic','Still readable.','Gaming','[]',${now},0);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${randomUUID()}','${frozenStreamId}','${users.frozenowner.id}','choice','Frozen poll','','','["Yes please","Not now"]',${now},0);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${randomUUID()}','${suspendedStreamId}','${users.viewer.id}','topic','Hidden topic','Not public.','Gaming','[]',${now},0);`,
  `INSERT INTO moderation_actions(id,target_kind,target_id,streamer_id,action,reason,note,notify_owner,actor_id,created_at) VALUES ('${randomUUID()}','streamer','${frozenStreamId}','${frozenStreamId}','freeze','Under review','Seeded for tests',1,'${users.admin.id}',${now});`,
  `INSERT INTO moderation_actions(id,target_kind,target_id,streamer_id,action,reason,note,notify_owner,actor_id,created_at) VALUES ('${randomUUID()}','streamer','${suspendedStreamId}','${suspendedStreamId}','suspend','Repeated spam','Seeded for tests',0,'${users.admin.id}',${now});`,
);
// The official StreamBullets page (item 46): pinned first in the directory. Never seeded by a migration (R14).
const officialStreamId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision,is_official) VALUES ('${officialStreamId}','${users.officialowner.id}','streambullets','StreamBullets','Ideas and bug reports for StreamBullets.',0,1);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed,status,status_reason,status_changed_at) VALUES ('${randomUUID()}','${officialStreamId}','${users.viewer.id}','topic','Dark mode for the overlay','Please.','design','[]',${now},0,'planned',NULL,${now});`,
);
// A page that uses every feature table from migrations 0008–0010, kept apart from the pages other specs count.
const featureStreamId: string = randomUUID();
const featureTopicId: string = randomUUID();
const mashPollId: string = randomUUID();
const seriesId: string = randomUUID();
statements.push(
  `INSERT INTO streamers(id,owner_id,handle,name,about,revision,logo,support_card) VALUES ('${featureStreamId}','${users.featureowner.id}','feature_host','Feature host','Schedule, cards, links and Mash Battle.',0,NULL,1);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${featureTopicId}','${featureStreamId}','${users.viewer.id}','topic','Mic shootout','USB or XLR?','Tech & setups','[]',${now},0);`,
  `INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${mashPollId}','${featureStreamId}','${users.featureowner.id}','choice','Which boss first?','','','["Malenia","Radahn","Fire Giant"]',${now},0);`,
  `INSERT INTO entry_mash(entry_id,duration_s,phase) VALUES ('${mashPollId}',30,'setup');`,
  `INSERT INTO entry_votes(entry_id,user_id,choice) VALUES ('${mashPollId}','${users.viewer.id}',1);`,
  `INSERT INTO mash_taps(entry_id,user_id,side,taps,assisted_taps) VALUES ('${mashPollId}','${users.viewer.id}',1,25,0);`,
  `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${randomUUID()}','${featureStreamId}',NULL,'Mic shootout','Bring your questions.',${now + 86_400_000},180,'twitch','https://twitch.tv/feature_host','scheduled',0,NULL,'UTC',${now},${now});`,
  `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${randomUUID()}','${featureStreamId}','${seriesId}','Variety night','',${now + 2 * 86_400_000},120,'youtube','https://youtube.com/@feature_host','scheduled',20,${now + 84 * 86_400_000},'Europe/Berlin',${now},${now});`,
  `INSERT INTO stream_events(id,streamer_id,series_id,title,notes,starts_at,duration_min,platform,url,status,vod_url,repeat_days,repeat_until,tz,created_at,updated_at) VALUES ('${randomUUID()}','${featureStreamId}',NULL,'Desk setup Q&A','',${now - 86_400_000},120,'twitch','https://twitch.tv/feature_host','ended','https://twitch.tv/videos/1',0,NULL,'UTC',${now},${now});`,
  `INSERT INTO stream_event_topics(event_id,entry_id) SELECT id,'${featureTopicId}' FROM stream_events WHERE title='Mic shootout';`,
  `INSERT INTO community_cards(id,streamer_id,position,icon,title,body,button_label,button_target) VALUES ('${randomUUID()}','${featureStreamId}',0,NULL,'Bring an idea','Suggest a topic, vote on your favorites, and discuss it with everyone.','Browse topics','tab:topics');`,
  `INSERT INTO community_cards(id,streamer_id,position,icon,title,body,button_label,button_target) VALUES ('${randomUUID()}','${featureStreamId}',1,'discord','Join the Discord','Clips, stream reminders and the occasional late-night co-op.','Join the Discord','https://discord.gg/feature_host');`,
  `INSERT INTO streamer_links(id,streamer_id,position,kind,label,url) VALUES ('${randomUUID()}','${featureStreamId}',0,'kofi',NULL,'https://ko-fi.com/feature_host');`,
  `INSERT INTO streamer_links(id,streamer_id,position,kind,label,url) VALUES ('${randomUUID()}','${featureStreamId}',1,'other','Merch tips','https://merch.example.test/feature_host');`,
  `INSERT INTO overlay_state(streamer_id,air,preview,position,size,instant,show_results,message,message_style,revision,updated_at) VALUES ('${featureStreamId}','{"type":"poll","ref":"${mashPollId}"}','{"type":"topic","ref":"${featureTopicId}"}','lower','m',0,1,'BRB 5 min','info',0,${now});`,
);
const seedPath: string = resolve(directory, "seed.sql");
await writeFile(seedPath, statements.join("\n"), { mode: 0o600 });
execute(["d1", "execute", "DB", "--local", "--persist-to", statePath, "--file", seedPath]);
await writeFile(resolve(directory, "sessions.json"), JSON.stringify(users), { mode: 0o600 });
const child: ChildProcess = spawn(
  process.execPath,
  [
    wrangler,
    "dev",
    ...common,
    "--local",
    "--port",
    "5173",
    "--ip",
    "127.0.0.1",
    "--persist-to",
    statePath,
    "--inspector-port",
    "0",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("error", (error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code: number | null) => {
  process.exitCode = code ?? 1;
});
