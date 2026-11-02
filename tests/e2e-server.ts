import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { makeSignature } from 'better-auth/crypto';

interface BuildConfig {
  main: string;
  assets?: { directory: string; [key: string]: unknown };
  d1_databases: { binding: string; database_name: string; database_id?: string; migrations_dir?: string }[];
  [key: string]: unknown;
}

const root: string = process.cwd();
const directory: string = resolve(root, '.wrangler/e2e');
const buildPath: string = resolve(root, 'build/server/wrangler.json');
const build: BuildConfig = JSON.parse(await readFile(buildPath, 'utf8')) as BuildConfig;
if (!build.main || !Array.isArray(build.d1_databases) || build.d1_databases.length !== 1) throw new Error('Build the application before browser tests.');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const secret: string = randomBytes(32).toString('hex');
const databaseId: string = randomUUID();
const config: BuildConfig = {
  ...build,
  main: resolve(dirname(buildPath), build.main),
  ...(build.assets ? { assets: { ...build.assets, directory: resolve(dirname(buildPath), build.assets.directory) } } : {}),
  vars: { APP_ORIGIN: 'http://localhost:5173' },
  d1_databases: build.d1_databases.map((database) => ({ ...database, database_id: databaseId, migrations_dir: resolve(root, 'drizzle') })),
};
const configPath: string = resolve(directory, 'wrangler.json');
const statePath: string = resolve(directory, 'state');
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await writeFile(resolve(directory, '.env'), `BETTER_AUTH_SECRET=${secret}\n`, { mode: 0o600 });
const wrangler: string = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const common: string[] = ['--config', configPath, '--env-file', resolve(directory, '.env')];
function execute(args: string[]): void {
  const result = spawnSync(process.execPath, [wrangler, ...args, ...common], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local test setup failed with exit ${result.status}.`);
}
execute(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', statePath]);
const now: number = Date.now();
const users: Record<string, { id: string; cookie: string }> = {};
const statements: string[] = [];
for (const role of ['owner', 'viewer', 'newcomer', 'otherowner', 'paginationowner']) {
  const id: string = randomUUID();
  const token: string = randomBytes(24).toString('hex');
  users[role] = { id, cookie: encodeURIComponent(`${token}.${await makeSignature(token, secret)}`) };
  statements.push(`INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('${id}','${role}','${role}@example.test',1,${now},${now});`);
  statements.push(`INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('${randomUUID()}','${token}','${id}',${now + 86_400_000},${now},${now});`);
}
const streamId: string = randomUUID();
statements.push(`INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${streamId}','${users.owner.id}','test_host','Test host','A test community.',0);`);
statements.push(`INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${randomUUID()}','${users.otherowner.id}','other_host','Other host','Another test community.',0);`);
const paginationStreamId: string = randomUUID();
statements.push(`INSERT INTO streamers(id,owner_id,handle,name,about,revision) VALUES ('${paginationStreamId}','${users.paginationowner.id}','pagination_host','Pagination host','A community with older entries.',0);`);
for (let index: number = 1; index <= 55; index += 1) {
  statements.push(`INSERT INTO entries(id,streamer_id,author_id,kind,title,body,category,options,created_at,revealed) VALUES ('${randomUUID()}','${paginationStreamId}','${users.paginationowner.id}','topic','Archive topic ${String(index).padStart(2, '0')}','An older conversation.','Tech & setups','[]',${now + index},0);`);
}
const seedPath: string = resolve(directory, 'seed.sql');
await writeFile(seedPath, statements.join('\n'), { mode: 0o600 });
execute(['d1', 'execute', 'DB', '--local', '--persist-to', statePath, '--file', seedPath]);
await writeFile(resolve(directory, 'sessions.json'), JSON.stringify(users), { mode: 0o600 });
const child: ChildProcess = spawn(process.execPath, [wrangler, 'dev', ...common, '--local', '--port', '5173', '--ip', '127.0.0.1', '--persist-to', statePath, '--inspector-port', '0'], {
  stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
child.on('error', (error: Error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code: number | null) => { process.exitCode = code ?? 1; });
