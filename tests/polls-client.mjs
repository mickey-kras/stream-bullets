import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/polls.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function snapshot(id, signedIn = true) {
  return {
    polls: [A, B].map(pollId => ({
      id: pollId, question: `Discussion ${pollId === A ? 'A' : 'B'}`, kind: 'choice', options: ['Yes', 'No'],
      endsAt: 0, revealed: false, total: 0, score: 0, counts: [0, 0], myVote: null,
      likes: 0, dislikes: 0, reaction: 0, comments: 1,
    })),
    comments: [{ id: 'comment', mine: true, text: `Comment for ${id}`, createdAt: 0 }],
    canHost: false, signedIn, serverNow: Date.now(),
  };
}
// Run the actual client against controlled network promises and minimal DOM surfaces.
// No timers or live server are needed, so headers/body/POST races are deterministic.
function client() {
  class Node extends EventTarget {
    hidden = false;
    value = '';
    textContent = '';
    innerHTML = '';
    disabled = false;
    elements = { namedItem: () => ({ required: true }) };
    querySelectorAll() { return []; }
    querySelector() { return null; }
    scrollIntoView() {}
  }
  const nodes = new Map();
  const el = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector);
  };
  const document = Object.assign(new EventTarget(), { hidden: false, activeElement: null });
  const window = new EventTarget();
  const location = { hash: '', pathname: '/', origin: 'https://example.test' };
  const gets = [], posts = [], intervals = [];
  const context = vm.createContext({
    el, esc: value => value, icon: () => '', notify() {}, commentText: value => value, authorName: value => value,
    showView() {}, location, history: { replaceState() { location.hash = ''; } }, document, window,
    setInterval(callback, delay) { intervals.push({ callback, delay }); }, Date, HTMLElement: Node, Element: Node,
    fetch(url, options) {
      const response = deferred();
      (options?.method === 'POST' ? posts : gets).push({ url, body: options?.body && JSON.parse(options.body), ...response });
      return response.promise;
    },
  });
  vm.runInContext(source, context);
  return {
    el, gets, posts, document,
    navigate(id) { location.hash = id ? `#poll=${id}` : ''; window.dispatchEvent(new Event('hashchange')); },
    type(value) { el('#poll-comment-text').value = value; el('#poll-comment-text').dispatchEvent(new Event('input')); },
    submit() { el('#poll-comment-form').dispatchEvent(new Event('submit', { cancelable: true })); },
    react() {
      const button = Object.assign(new Node(), { dataset: { react: '1', id: A } });
      button.closest = () => button;
      const event = new Event('click');
      Object.defineProperty(event, 'target', { value: button });
      el('#poll-cards').dispatchEvent(event);
    },
    refresh() { intervals.find(interval => interval.delay === 2000).callback(); },
    async load(id, signedIn = true) {
      gets.at(-1).resolve({ ok: true, json: async () => snapshot(id, signedIn) });
      await settle();
    },
  };
}

test('navigation immediately hides and disables the old discussion until the selected thread loads', async () => {
  const c = client();
  c.navigate(A); await c.load(A);
  assert.equal(c.el('#poll-discussion-reference').textContent, 'Discussion A');
  c.navigate(B);
  assert.equal(c.el('#poll-discussion').hidden, true);
  assert.equal(c.el('#poll-comment-text').disabled, true);
  c.document.dispatchEvent(new Event('profilechange'));
  c.type('Response to the old thread'); c.submit();
  assert.equal(c.posts.length, 0);
  await c.load(B);
  assert.equal(c.el('#poll-discussion-reference').textContent, 'Discussion B');
  assert.match(c.el('#poll-comments').innerHTML, new RegExp(B));
  assert.equal(c.el('#poll-discussion').hidden, false);
  c.type('Response to B'); c.submit();
  assert.deepEqual(c.posts[0].body, { action: 'comment', id: B, text: 'Response to B' });
});

test('navigation during JSON parsing cannot install an old snapshot, including A to B to A', async () => {
  for (const returnToA of [false, true]) {
    const c = client(), body = deferred();
    c.navigate(A);
    c.gets[0].resolve({ ok: true, json: () => body.promise });
    await settle();
    c.navigate(B);
    if (returnToA) c.navigate(A);
    body.resolve(snapshot(A)); await settle();
    assert.equal(c.el('#poll-discussion').hidden, true);
    assert.equal(c.el('#poll-cards').innerHTML, '');
    c.type('Should not post'); c.submit();
    assert.equal(c.posts.length, 0);
    c.refresh(); await c.load(returnToA ? A : B);
    assert.equal(c.el('#poll-discussion').hidden, false);
  }
});

test('successful POST clears only the submitted draft and keeps refresh from enabling duplicate submission', async () => {
  for (const edit of [false, true]) {
    const c = client();
    c.navigate(A); await c.load(A);
    c.type('Original'); c.submit();
    if (edit) { c.type('Changed'); c.type('Original'); }
    c.refresh(); await c.load(A);
    assert.equal(c.el('#poll-comment-form button').disabled, true);
    c.submit(); assert.equal(c.posts.length, 1);
    c.posts[0].resolve({ ok: true }); await settle();
    assert.equal(c.el('#poll-comment-text').value, edit ? 'Original' : '');
    await c.load(A);
    assert.equal(c.el('#poll-comment-form button').disabled, false);
  }
});

test('POST completion after navigation preserves a new thread draft, even when returning to the same poll', async () => {
  for (const returnToA of [false, true]) {
    const c = client();
    c.navigate(A); await c.load(A);
    c.type('Posted A'); c.submit();
    c.navigate(B); await c.load(B);
    if (returnToA) { c.navigate(A); await c.load(A); }
    c.type('New draft');
    c.posts[0].resolve({ ok: true }); await settle();
    assert.equal(c.el('#poll-comment-text').value, 'New draft');
    await c.load(returnToA ? A : B);
    assert.equal(c.el('#poll-comment-text').value, 'New draft');
  }
});

test('failed POST cannot place errors in another thread or enable a signed-out form', async () => {
  const c = client();
  c.navigate(A); await c.load(A);
  c.type('Posted A'); c.submit();
  c.navigate(B); await c.load(B, false);
  c.posts[0].resolve({ ok: false, json: async () => ({ error: 'Old thread error' }) });
  await settle();
  assert.equal(c.el('#poll-comment-error').textContent, '');
  assert.equal(c.el('#poll-comment-form button').disabled, true);
  c.type('Signed out'); c.submit(); assert.equal(c.posts.length, 1);
});


test('finishing a poll reaction immediately re-enables the discussion composer', async () => {
  const c = client();
  c.navigate(A); await c.load(A);
  c.react();
  assert.equal(c.posts[0].body.action, 'react');
  c.posts[0].resolve({ ok: true }); await settle();
  await c.load(A);
  assert.equal(c.el('#poll-comment-form button').disabled, false);
});
