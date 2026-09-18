import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import type { CallFeedEvent } from '../call-feed.js';
import { loadConfig } from '../config.js';
import { Store } from '../db/index.js';
import { LocalioServer } from '../server.js';
import { sseFrame } from './app.js';

/**
 * The claim the Phone panel takes when Pick up is clicked.
 *
 * **None of this is what makes a call answerable once** — `db.test.ts` covers that, and it
 * is the conditional UPDATE in `Calls.answer()`. What these hold is the narrower property:
 * that a tab which has lost can be told so *before* it spends a microphone prompt, and
 * that losing the claim never becomes a way to lose the call itself.
 */

async function fixture(): Promise<{ server: LocalioServer; store: Store; sid: string }> {
  const store = Store.open({ path: ':memory:' });
  const account = store.accounts.create({ friendlyName: 'test' });
  store.numbers.create({ phoneNumber: '+15550000001', accountSid: account.accountSid });
  const config = { ...loadConfig({}), dbPath: ':memory:' };
  const server = new LocalioServer({ store, config, logger: pino({ level: 'silent' }) });
  await server.app.ready();
  const call = store.calls.create({
    accountSid: account.accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'queued',
    answerUrl: 'http://localhost:3000/voice',
  });
  return { server, store, sid: call.sid };
}

const claim = (server: LocalioServer, sid: string, holder: string) =>
  server.app.inject({ method: 'POST', url: `/api/calls/${sid}/claim`, payload: { holder } });

test('one tab claims a waiting call and the next is refused', async () => {
  const { server, sid } = await fixture();

  const first = await claim(server, sid, 'tab-a');
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().holder, 'tab-a');

  const second = await claim(server, sid, 'tab-b');
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'already_claimed');

  // The same tab retrying is the same pickup, not a conflict.
  assert.equal((await claim(server, sid, 'tab-a')).statusCode, 200);
});

/** The whole point of the claim: it is *visible* to the tabs that did not get it. */
test('a claim shows on the listing every other tab polls', async () => {
  const { server, sid } = await fixture();

  const before = await server.app.inject({ url: '/api/calls?status=queued' });
  assert.equal(before.json().calls[0].claimed_by, null);

  await claim(server, sid, 'tab-a');
  const after = await server.app.inject({ url: '/api/calls?status=queued' });
  assert.equal(after.json().calls[0].claimed_by, 'tab-a');
});

test('releasing hands the call to the next tab', async () => {
  const { server, sid } = await fixture();
  await claim(server, sid, 'tab-a');

  const released = await server.app.inject({
    method: 'DELETE',
    url: `/api/calls/${sid}/claim?holder=tab-a`,
  });
  assert.equal(released.statusCode, 204);
  assert.equal((await claim(server, sid, 'tab-b')).statusCode, 200);
});

/**
 * A release from somebody who no longer holds it is a **no-op, not an error**. Treating it
 * as an error would make a page that lost the race retry; honouring it would let a lapsed
 * claimant free a call somebody else is already picking up.
 */
test('releasing a claim you do not hold leaves it alone', async () => {
  const { server, sid } = await fixture();
  await claim(server, sid, 'tab-a');

  const stray = await server.app.inject({
    method: 'DELETE',
    url: `/api/calls/${sid}/claim?holder=tab-b`,
  });
  assert.equal(stray.statusCode, 204);

  const listing = await server.app.inject({ url: '/api/calls?status=queued' });
  assert.equal(listing.json().calls[0].claimed_by, 'tab-a');
});

test('a call that is not waiting cannot be claimed', async () => {
  const { server, store, sid } = await fixture();
  store.calls.answer(sid);

  const late = await claim(server, sid, 'tab-a');
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'not_queued');

  const missing = await claim(server, 'CAdeadbeef', 'tab-a');
  assert.equal(missing.statusCode, 409);
});

/** Declining drops the claim with the call: there is nothing left to be holding. */
test('declining releases the claim', async () => {
  const { server, store, sid } = await fixture();
  await claim(server, sid, 'tab-a');

  const declined = await server.app.inject({ method: 'DELETE', url: `/api/calls/${sid}` });
  assert.equal(declined.statusCode, 204);
  assert.equal(store.calls.find(sid)?.status, 'canceled');

  const listing = await server.app.inject({ url: '/api/calls' });
  assert.equal(listing.json().calls[0].claimed_by, null);
});

test('a claim without a holder is a bad request', async () => {
  const { server, sid } = await fixture();
  const bad = await server.app.inject({
    method: 'POST',
    url: `/api/calls/${sid}/claim`,
    payload: {},
  });
  assert.equal(bad.statusCode, 400);
});

/* --------------------------------------------------------------------- feed */

/**
 * The push channel behind `/api/calls/stream`.
 *
 * Tested at the feed rather than over a socket, because everything here is hermetic — no
 * sockets, no network. That covers every publish site; what it deliberately leaves out is
 * the ten lines of HTTP framing, which `sseFrame` below holds the format of.
 *
 * **Still advisory.** Nothing asserted here may ever become the reason a pickup happens
 * once — that is `Calls.answer()`'s conditional UPDATE, and the page keeps its poll.
 */
function record(server: LocalioServer): CallFeedEvent[] {
  const seen: CallFeedEvent[] = [];
  server.feed.subscribe({ event: (event) => seen.push(event) });
  return seen;
}

test('claiming and releasing are each announced once', async () => {
  const { server, sid } = await fixture();
  const seen = record(server);

  await claim(server, sid, 'tab-a');
  assert.deepEqual(
    seen.map((e) => e.kind),
    ['claimed'],
  );
  assert.equal(seen[0]?.call.sid, sid);
  // The frame carries who holds it, so a page needs no second request to grey the row out.
  assert.equal(seen[0]?.claimedBy, 'tab-a');

  // A refused claim changed nothing, so it is not news.
  await claim(server, sid, 'tab-b');
  assert.equal(seen.length, 1);

  await server.app.inject({
    method: 'DELETE',
    url: `/api/calls/${sid}/claim?holder=tab-a`,
  });
  assert.deepEqual(
    seen.map((e) => e.kind),
    ['claimed', 'released'],
  );
  assert.equal(seen[1]?.claimedBy, null);
});

/**
 * A release that released nothing must stay silent. Announcing it would tell every other
 * tab to re-enable a button for a call somebody else is now mid-pickup on.
 */
test('a stray release is not announced', async () => {
  const { server, sid } = await fixture();
  await claim(server, sid, 'tab-a');
  const seen = record(server);

  await server.app.inject({ method: 'DELETE', url: `/api/calls/${sid}/claim?holder=tab-b` });
  assert.deepEqual(seen, []);
  // And the claim is still tab-a's.
  const listing = await server.app.inject({ url: '/api/calls?status=queued' });
  assert.equal(listing.json().calls[0].claimed_by, 'tab-a');
});

test('declining is announced with the claim already gone', async () => {
  const { server, sid } = await fixture();
  await claim(server, sid, 'tab-a');
  const seen = record(server);

  await server.app.inject({ method: 'DELETE', url: `/api/calls/${sid}` });
  assert.deepEqual(
    seen.map((e) => e.kind),
    ['declined'],
  );
  assert.equal(seen[0]?.call.status, 'canceled');
  // Not `tab-a`: the call is gone, so nobody is picking it up any more.
  assert.equal(seen[0]?.claimedBy, null);
});

test('a decline that changed nothing is not announced', async () => {
  const { server, store, sid } = await fixture();
  store.calls.answer(sid);
  const seen = record(server);

  const late = await server.app.inject({ method: 'DELETE', url: `/api/calls/${sid}` });
  assert.equal(late.statusCode, 409);
  assert.deepEqual(seen, []);
});

/** How many streams are open, which is the only way to see the channel from outside. */
test('settings counts the open streams', async () => {
  const { server } = await fixture();
  const before = await server.app.inject({ url: '/api/settings' });
  assert.equal(before.json().call_stream_clients, 0);

  const stop = server.feed.subscribe({ event: () => {} });
  const during = await server.app.inject({ url: '/api/settings' });
  assert.equal(during.json().call_stream_clients, 1);

  stop();
  const after = await server.app.inject({ url: '/api/settings' });
  assert.equal(after.json().call_stream_clients, 0);
});

/* ----------------------------------------------------------------- the wire */

/**
 * The one part of the stream a hermetic test can hold.
 *
 * Every line of the payload needs its own `data:` prefix and the frame ends on a blank
 * line — get either wrong and `EventSource` silently delivers nothing, with the page
 * falling back to its poll and no sign anywhere that the stream is dead.
 */
test('an SSE frame is one event, prefixed lines, and a blank line', () => {
  assert.equal(sseFrame('ringing', { sid: 'CA1' }), 'event: ringing\ndata: {"sid":"CA1"}\n\n');
  assert.equal(sseFrame('snapshot', undefined), 'event: snapshot\ndata: null\n\n');
  // A newline inside the payload would end the frame early if it were not re-prefixed.
  assert.equal(sseFrame('note', 'one\ntwo'), 'event: note\ndata: "one\\ntwo"\n\n');
});
