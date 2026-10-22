import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { z } from 'zod';
const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../drizzle/'+file, import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
let queryCount = 0;
const env = { POLL_HOST_EMAIL: 'host@example.test', DB: { prepare(sql) {
  queryCount++;
  const statement = sqlite.prepare(sql);
  return { bind(...parameters) { return {
    async all() { return { results: statement.all(...parameters) }; },
    async first() { return statement.get(...parameters) ?? null; },
    async run() { return { meta: { changes: statement.run(...parameters).changes } }; },
  }; }, async all() { return { results: statement.all() }; } };
} } };
const source = readFileSync(new URL('../app/api/polls/route.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const routes = {};
new Function('require', 'exports', output)((name) => {
  if (name === 'cloudflare:workers') return { env };
  if (name === 'zod') return { z };
  throw new Error(`Unexpected import: ${name}`);
}, routes);
const base = 'https://polls.example.test';
async function get(user = 'test-viewer', query = '') {
  const response = await routes.GET(new Request(`${base}/api/polls${query}`, { headers: { 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': 'viewer@example.test' } }));
  assert.equal(response.status, 200); return response.json();
}
async function post(data, { viewer = false, user = 'test-host', origin = base } = {}) {
  return routes.POST(new Request(`${base}/api/polls`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': viewer ? 'viewer@example.test' : 'host@example.test' }, body: JSON.stringify(data) }));
}
assert.equal((await routes.POST(new Request(`${base}/api/polls`, {method:'POST', headers:{Origin:base}, body:'{}'}))).status,401);
assert.equal((await post({action:'create',question:'Neutral meter',kind:'binary',options:['Yes','No'],duration:300})).status,200);
const initial = await get();
const poll = initial.polls.find(p => p.endsAt > Date.now() && !p.revealed);
assert.ok(poll, 'Start a local preview poll before running these checks');
assert.equal((await post({action:'vote',id:poll.id,choice:0},{origin:'https://invalid.example'})).status,403);
assert.equal((await post({action:'reveal',id:poll.id},{viewer:true})).status,403);
assert.equal((await post({action:'vote',id:poll.id,choice:5})).status,409);
const create={action:'create',question:'Deadline verification',kind:'choice',options:['First','Second'],duration:15};
assert.equal((await post(create,{viewer:true})).status,403);
assert.equal((await post(create)).status,409);
for(const result of await Promise.all(Array.from({length:5},()=>post({action:'vote',id:poll.id,choice:0},{user:'same-viewer',viewer:true})))) assert.equal(result.status,200);
let updated=(await get('same-viewer')).polls.find(p=>p.id===poll.id);
assert.equal(updated.total,1);assert.equal(updated.myVote,0);assert.equal(updated.score,100);assert.equal(updated.counts,null);
assert.equal((await post({action:'vote',id:poll.id,choice:1},{user:'same-viewer',viewer:true})).status,200);
updated=(await get()).polls.find(p=>p.id===poll.id);assert.equal(updated.total,1);assert.equal(updated.score,-100);
assert.equal((await post({action:'vote',id:poll.id,choice:0},{user:'another-viewer',viewer:true})).status,200);
updated=(await get()).polls.find(p=>p.id===poll.id);assert.equal(updated.total,2);assert.equal(updated.score,0);
assert.equal((await post({action:'reveal',id:poll.id})).status,200);
updated=(await get()).polls.find(p=>p.id===poll.id);assert.equal(updated.revealed,true);assert.deepEqual(updated.counts,[1,1]);
assert.equal((await post({action:'vote',id:poll.id,choice:0})).status,409);
const starts=await Promise.all([post(create),post(create)]);assert.deepEqual(starts.map(r=>r.status).sort(),[200,409]);
const timed=(await get()).polls[0];assert.equal((await post({action:'vote',id:timed.id,choice:0})).status,200);
assert.deepEqual((await get()).polls[0].counts,[1,0]);
const realNow = Date.now;
Date.now = () => timed.endsAt + 1;
assert.equal((await post({action:'vote',id:timed.id,choice:1})).status,409);
assert.equal((await post({action:'reveal',id:timed.id})).status,200);
Date.now = realNow;
assert.equal((await post({...create,question:'Unlimited question',duration:0},{viewer:true})).status,403);
assert.equal((await post({...create,question:'Unlimited question',duration:0})).status,200);
const unlimited=(await get()).polls.find(p=>p.endsAt===0);
assert.ok(unlimited);
Date.now=()=>realNow()+365*24*60*60*1000;
assert.equal((await post({action:'vote',id:unlimited.id,choice:1},{viewer:true})).status,200);
Date.now=realNow;
for(let i=0;i<3;i++)assert.equal((await post({action:'react',id:poll.id,value:1},{viewer:true,user:'rater'})).status,200);
updated=(await get('rater','?sort=top')).polls[0];assert.equal(updated.id,poll.id);assert.equal(updated.likes,1);assert.equal(updated.reaction,1);
assert.equal((await post({action:'react',id:poll.id,value:-1},{viewer:true,user:'rater'})).status,200);
updated=(await get('rater',`?poll=${poll.id}`)).polls[0];assert.equal(updated.likes,0);assert.equal(updated.dislikes,1);
assert.equal((await post({action:'react',id:poll.id,value:0},{viewer:true,user:'rater'})).status,200);
updated=(await get('rater',`?poll=${poll.id}`)).polls[0];assert.equal(updated.dislikes,0);assert.equal(updated.reaction,0);
assert.equal((await post({action:'comment',id:unlimited.id,text:'   '},{viewer:true})).status,400);
assert.equal((await post({action:'comment',id:unlimited.id,text:'A reason for my vote.'},{viewer:true,user:'commenter'})).status,200);
const thread=await get('commenter',`?poll=${unlimited.id}`);assert.equal(thread.polls[0].comments,1);assert.equal(thread.comments[0].text,'A reason for my vote.');assert.equal(thread.comments[0].mine,true);
assert.equal((await get('different-person',`?poll=${unlimited.id}`)).comments[0].mine,false);
assert.equal((await post({action:'reveal',id:unlimited.id},{viewer:true})).status,403);
assert.equal((await post({action:'reveal',id:unlimited.id})).status,200);
assert.equal((await post({action:'vote',id:unlimited.id,choice:0},{viewer:true})).status,409);
assert.equal((await get('test-viewer', '?sort=newest')).polls.length, 3);
for (let i = 0; i < 45; i++) sqlite.prepare('INSERT INTO polls VALUES (?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), 'Another poll', 'choice', '["A","B"]', i, 0, 0);
queryCount = 0;
assert.equal((await get()).polls.length, 48);
assert.equal(queryCount, 4);
queryCount = 0;
assert.equal((await get('same-viewer', `?poll=${poll.id}`)).polls[0].myVote, 1);
assert.equal(queryCount, 5);
for (const query of ['?poll=bad', '?before=1:bad', `?before=1:${poll.id}`, `?poll=${poll.id}&before=9007199254740992:${poll.id}`, '?sort=unknown', '?extra=1', '?sort=top&sort=newest']) {
  assert.equal((await routes.GET(new Request(base + '/api/polls' + query))).status, 400);
}
const insert = sqlite.prepare('INSERT INTO poll_comments VALUES (?, ?, ?, ?, ?)');
for (let i = 0; i < 205; i++) insert.run(crypto.randomUUID(), poll.id, 'history-user', 'History ' + i, 1000);
let cursor = null;
const seen = new Set();
do {
  const page = await get('history-user', `?poll=${poll.id}` + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
  assert.ok(page.comments.length <= 100);
  for (const comment of page.comments) { assert.ok(!seen.has(comment.id)); seen.add(comment.id); }
  assert.deepEqual(page.comments.map(c => c.id), page.comments.map(c => c.id).sort());
  cursor = page.nextCommentsCursor;
} while (cursor);
assert.equal(seen.size, 205);
const burst = await Promise.all(Array.from({length: 8}, () => post({action:'comment',id:poll.id,text:'Burst'}, {viewer:true,user:'burst-user'})));
assert.equal(burst.filter(r => r.status === 200).length, 5);
assert.equal(burst.filter(r => r.status === 429).length, 3);
assert.equal(burst.find(r => r.status === 429).headers.get('Retry-After'), '60');
assert.equal((await post({action:'comment',id:unlimited.id,text:'Independent poll'}, {user:'burst-user'})).status, 200);
assert.equal((await post({action:'comment',id:crypto.randomUUID(),text:'Missing'}, {user:'burst-user'})).status, 404);
Date.now = () => realNow() + 60_001;
assert.equal((await post({action:'comment',id:poll.id,text:'Window elapsed'}, {user:'burst-user'})).status, 200);
Date.now = realNow;
async function streamPost(chunks, contentLength) {
  let index = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const headers = { Origin:base, 'oai-authenticated-user-id':'stream-user', ...(contentLength ? {'Content-Length':contentLength} : {}) };
  const response = await routes.POST(new Request(base + '/api/polls', {method:'POST', headers, body:stream, duplex:'half'}));
  return {response, cancelled, consumed:index};
}
const encode = value => new TextEncoder().encode(value);
for (const length of [undefined, '1']) {
  const result = await streamPost([new Uint8Array(8192), new Uint8Array(8193), new Uint8Array(8192)], length);
  assert.equal(result.response.status, 413); assert.equal(result.cancelled, true); assert.equal(result.consumed, 2);
}
const escaped = '{"action":"comment","id":"' + poll.id + '","text":"' + String.raw`\u0061`.repeat(2000) + '"}';
assert.equal((await streamPost([encode(escaped)])).response.status, 200);
for (const text of ['界'.repeat(2000), '😀'.repeat(1000)]) {
  const encoded = encode(JSON.stringify({action:'comment', id:poll.id, text}));
  assert.equal((await streamPost([encoded.slice(0, 80), encoded.slice(80)])).response.status, 200);
}
assert.equal((await streamPost([new Uint8Array([255])])).response.status, 400);
assert.equal((await streamPost([encode('{')])).response.status, 400);
assert.equal((await post({action:'comment',id:poll.id,text:'a'.repeat(2001)})).status, 400);
assert.ok(sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM poll_comments WHERE poll_id = ? ORDER BY created_at DESC, id DESC LIMIT 101").all(poll.id).some(row => row.detail.includes('poll_comments_history_idx')));
assert.ok(sqlite.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM poll_comments WHERE poll_id = ? AND user_id = ? AND created_at > ?").all(poll.id, 'burst-user', 0).some(row => row.detail.includes('poll_comments_rate_idx')));
sqlite.close();
console.log('Passed: authorization, atomic writes, bounded body streams, grouped queries, indexed history pagination, comment rate limits, deadline and results.');
