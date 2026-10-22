import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { z } from 'zod';
const sqlite = new DatabaseSync(':memory:');
for (const file of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../drizzle/'+file, import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
const env = { POLL_HOST_EMAIL: 'host@example.test', DB: { prepare(sql) {
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
sqlite.close();
console.log('Passed: host authorization, origin validation, vote bounds, concurrent deduplication, vote changes, shared totals, reveal, concurrent starts, server deadline.');
