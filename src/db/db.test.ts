import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentCount } from './messages.js';
import { nanpNumber } from './numbers.js';
import { Store } from './index.js';

function store(): Store {
  return Store.open({ path: ':memory:' });
}

function seeded(): { store: Store; accountSid: string } {
  const s = store();
  const account = s.accounts.create({ friendlyName: 'dev' });
  s.numbers.create({
    phoneNumber: '+15550000001',
    accountSid: account.accountSid,
    voiceUrl: 'http://app.test/voice',
  });
  return { store: s, accountSid: account.accountSid };
}

test('the migration runs on an empty database and is idempotent', () => {
  const s = store();
  assert.equal(s.db.pragma('user_version', { simple: true }), 3);
  assert.deepEqual(s.accounts.list(), []);
});

/* ---------------------------------------------------------------- subaccounts */

/**
 * A subaccount is a **full account** — its own `AC…`, its own token — that happens to name
 * a parent. Everything that takes an `account_sid` keeps working because of that.
 */
test('a subaccount is an account with a parent, and hydrates back with one', () => {
  const s = store();
  const parent = s.accounts.create({ friendlyName: 'parent' });
  const child = s.accounts.create({ friendlyName: 'child', parentAccountSid: parent.accountSid });

  assert.match(child.accountSid, /^AC[0-9a-f]{32}$/, 'a subaccount is still an AC');
  assert.notEqual(child.authToken, parent.authToken, 'a subaccount has its own token');
  assert.equal(child.status, 'active', 'a new account is active');
  assert.equal(s.accounts.find(child.accountSid)?.parentAccountSid, parent.accountSid);
  assert.equal(s.accounts.find(parent.accountSid)?.parentAccountSid, null);
  assert.deepEqual(
    s.accounts.subaccounts(parent.accountSid).map((account) => account.accountSid),
    [child.accountSid],
  );
  assert.equal(s.accounts.subaccountCount(parent.accountSid), 1);
  assert.equal(s.accounts.subaccountCount(child.accountSid), 0);
});

/**
 * **A child is not taken along by its parent's delete**, the way API keys are. It is a
 * second account with its own history, and deleting one account must not remove another.
 */
test('an account with subaccounts cannot be deleted until they are gone', () => {
  const s = store();
  const parent = s.accounts.create({ friendlyName: 'parent' });
  const child = s.accounts.create({ friendlyName: 'child', parentAccountSid: parent.accountSid });

  assert.equal(s.accounts.remove(parent.accountSid), 'has-subaccounts');
  assert.equal(s.accounts.remove(child.accountSid), 'deleted');
  assert.equal(s.accounts.remove(parent.accountSid), 'deleted');
});

/** A subaccount holds its own numbers, and is refused for them exactly as a parent is. */
test('a subaccount holding numbers is refused for its numbers', () => {
  const s = store();
  const parent = s.accounts.create({ friendlyName: 'parent' });
  const child = s.accounts.create({ friendlyName: 'child', parentAccountSid: parent.accountSid });
  s.numbers.create({ phoneNumber: '+15550000009', accountSid: child.accountSid });

  assert.equal(s.accounts.remove(child.accountSid), 'has-numbers');
  assert.equal(s.accounts.numberCount(child.accountSid), 1);
  assert.equal(s.accounts.numberCount(parent.accountSid), 0, 'a number does not roll up to the parent');
});

/** Status round-trips, and is the field the REST API refuses a credential on. */
test('an account status is updatable and sticks', () => {
  const s = store();
  const account = s.accounts.create({ friendlyName: 'dev' });
  assert.equal(s.accounts.update(account.accountSid, { status: 'suspended' })?.status, 'suspended');
  assert.equal(s.accounts.find(account.accountSid)?.status, 'suspended');
  // A patch that does not mention the status leaves it alone.
  assert.equal(s.accounts.update(account.accountSid, { friendlyName: 'renamed' })?.status, 'suspended');
});

/** `adopt` is the seed's second pass, and it links once rather than reparenting. */
test('adopt links a top-level account and never moves one that is already a child', () => {
  const s = store();
  const first = s.accounts.create({ friendlyName: 'first' });
  const second = s.accounts.create({ friendlyName: 'second' });
  const child = s.accounts.create({ friendlyName: 'child' });

  assert.equal(s.accounts.adopt(child.accountSid, first.accountSid), true);
  assert.equal(s.accounts.adopt(child.accountSid, second.accountSid), false, 'a child is not reparented');
  assert.equal(s.accounts.find(child.accountSid)?.parentAccountSid, first.accountSid);
});

/* --------------------------------------------------------------------- sids */

/** Every sid wears Twilio's shape: two letters and 32 hex. A lookalike passes here and fails there. */
test('every minted sid is two letters and 32 hex characters', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'inbound',
    status: 'queued',
  });
  const message = s.messages.create({
    accountSid,
    from: '+1',
    to: '+2',
    body: 'x',
    direction: 'inbound',
  });
  for (const [sid, prefix] of [
    [accountSid, 'AC'],
    [call.sid, 'CA'],
    [message.sid, 'SM'],
    [s.recordings.mint(), 'RE'],
    [s.numbers.list()[0]!.sid, 'PN'],
    [s.apiKeys.create({ accountSid }).sid, 'SK'],
  ] as const) {
    assert.match(sid, new RegExp(`^${prefix}[0-9a-f]{32}$`), `${sid} is not a ${prefix} sid`);
  }
});

/**
 * **Answering is take-once.** Two tabs answering one ringing call would be two voice
 * webhooks and two `<Connect><Stream>`s for a single `CallSid`, which is something no
 * provider can produce.
 */
test('only one answer of a queued call succeeds', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'outbound-api',
    status: 'queued',
  });
  assert.notEqual(s.calls.answer(call.sid), null, 'the first answer must win');
  assert.equal(s.calls.answer(call.sid), null, 'the second must not');
});

test('declining a call that was already answered fails', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'outbound-api',
    status: 'queued',
  });
  s.calls.answer(call.sid);
  assert.equal(s.calls.cancel(call.sid), false);
});

/** **Reading a queued call must not consume it** — looking at a ringing call is not answering it. */
test('listing queued calls leaves them answerable', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'outbound-api',
    status: 'queued',
  });
  assert.equal(s.calls.list({ status: 'queued' }).length, 1);
  assert.equal(s.calls.find(call.sid)?.status, 'queued');
  assert.notEqual(s.calls.answer(call.sid), null);
});

/** **Teardown is idempotent**, or a call posts two status callbacks. */
test('finishing a call twice keeps the first duration', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'inbound',
    status: 'ringing',
  });
  s.calls.markInProgress(call.sid);
  const first = s.calls.finish(call.sid, 'completed');
  const second = s.calls.finish(call.sid, 'failed');
  assert.equal(second?.status, 'completed', 'the second finish must not change the status');
  assert.equal(second?.endTime, first?.endTime);
});

test('the event log comes back in order with its json parsed', () => {
  const { store: s, accountSid } = seeded();
  const call = s.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'inbound',
    status: 'ringing',
  });
  s.calls.log(call.sid, 'webhook', { status: 200 });
  s.calls.log(call.sid, 'verb', { verb: 'Say' });
  const events = s.calls.events(call.sid);
  assert.deepEqual(events.map((e) => e.kind), ['webhook', 'verb']);
  assert.deepEqual(events[0]?.detail, { status: 200 });
});

/* ------------------------------------------------------------------- numbers */

test('a number is found by its E.164 value, which is the inbound lookup', () => {
  const { store: s } = seeded();
  assert.equal(s.numbers.findByNumber('+15550000001')?.voiceUrl, 'http://app.test/voice');
  assert.equal(s.numbers.findByNumber('+15559999999'), null);
});

/**
 * **A patch that mentions one field must not blank the rest**, and `null` is how a
 * cleared box is spelled. `undefined` means "not mentioned".
 */
test('a partial update keeps unmentioned fields and clears explicit nulls', () => {
  const { store: s } = seeded();
  const sid = s.numbers.list()[0]!.sid;
  s.numbers.update(sid, { smsUrl: 'http://app.test/sms' });
  assert.equal(s.numbers.find(sid)?.voiceUrl, 'http://app.test/voice', 'voice_url must survive');
  s.numbers.update(sid, { voiceUrl: null });
  assert.equal(s.numbers.find(sid)?.voiceUrl, null);
  assert.equal(s.numbers.find(sid)?.smsUrl, 'http://app.test/sms');
});

/** **The history stays when a number goes.** It holds the numbers as text, not as a key. */
test('deleting a number leaves its calls and messages behind', () => {
  const { store: s, accountSid } = seeded();
  s.calls.create({
    accountSid,
    from: '+15550000001',
    to: '+2',
    direction: 'inbound',
    status: 'completed',
  });
  s.messages.create({
    accountSid,
    from: '+2',
    to: '+15550000001',
    body: 'x',
    direction: 'inbound',
  });
  assert.deepEqual(s.numbers.usage('+15550000001'), { calls: 1, messages: 1 });
  assert.equal(s.numbers.remove(s.numbers.list()[0]!.sid), true);
  assert.equal(s.calls.list().length, 1);
  assert.equal(s.messages.list().length, 1);
});

test('an account holding numbers cannot be deleted, and says how many', () => {
  const { store: s, accountSid } = seeded();
  assert.equal(s.accounts.remove(accountSid), 'has-numbers');
  assert.equal(s.accounts.numberCount(accountSid), 1);
  s.numbers.remove(s.numbers.list()[0]!.sid);
  assert.equal(s.accounts.remove(accountSid), 'deleted');
});

/* ------------------------------------------------------------------ api keys */

test('an api key is a row of the account it opens', () => {
  const { store: s, accountSid } = seeded();
  const key = s.apiKeys.create({ accountSid, friendlyName: 'ci' });
  assert.equal(key.secret.length, 32);
  assert.deepEqual(s.apiKeys.find(key.sid), key);
  assert.deepEqual(s.apiKeys.list(accountSid).map((k) => k.sid), [key.sid]);
  assert.equal(s.accounts.keyCount(accountSid), 1);

  const renamed = s.apiKeys.update(key.sid, { friendlyName: 'ci 2' });
  assert.equal(renamed?.friendlyName, 'ci 2');
  assert.equal(renamed?.secret, key.secret, 'renaming does not rotate the secret');

  assert.equal(s.apiKeys.remove(key.sid), 'deleted');
  assert.equal(s.apiKeys.remove(key.sid), 'not-found');
});

/**
 * Keys are the account's own credentials, so they go with it. Without this the delete is
 * a bare `SQLITE_CONSTRAINT` from the foreign key, naming nothing.
 */
test('deleting an account takes its keys with it', () => {
  const { store: s, accountSid } = seeded();
  s.apiKeys.create({ accountSid });
  s.numbers.remove(s.numbers.list()[0]!.sid);
  assert.equal(s.accounts.remove(accountSid), 'deleted');
  assert.deepEqual(s.apiKeys.list(), []);
});

test('upsert is safe to run twice, which is what a seed file needs', () => {
  const s = store();
  const account = s.accounts.upsert({ accountSid: 'AC' + '0'.repeat(32), authToken: 't1' });
  s.numbers.upsert({ phoneNumber: '+15550000001', accountSid: account.accountSid, voiceUrl: 'http://a.test/1' });
  s.numbers.upsert({ phoneNumber: '+15550000001', accountSid: account.accountSid, voiceUrl: 'http://a.test/2' });
  assert.equal(s.numbers.list().length, 1);
  assert.equal(s.numbers.findByNumber('+15550000001')?.voiceUrl, 'http://a.test/2');
  assert.equal(s.accounts.list().length, 1);
});

/* -------------------------------------------------------------- area codes */

test('a generated number is a valid NANP line in the area code asked for', () => {
  for (let i = 0; i < 500; i += 1) {
    assert.match(nanpNumber('415'), /^\+1415[2-9]\d{6}$/);
  }
});

test('allocating in an area code never hands out the same number twice', () => {
  const { store: s, accountSid } = seeded();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const number = s.numbers.createInAreaCode('415', { accountSid });
    assert.notEqual(number, null);
    seen.add(number!.phoneNumber);
  }
  assert.equal(seen.size, 200, 'every allocation must be distinct');
  assert.equal(s.numbers.list(accountSid).length, 201, 'and every one is really held');
});

/**
 * The only thing that exercises the constraint-catch path: a `rand` that always returns
 * the same value makes every candidate identical, so the second allocation collides
 * twenty times and gives up.
 */
test('an exhausted area code is a null rather than a duplicate', () => {
  const { store: s, accountSid } = seeded();
  const first = s.numbers.createInAreaCode('415', { accountSid }, () => 0);
  assert.equal(first?.phoneNumber, '+14152000000');
  assert.equal(s.numbers.createInAreaCode('415', { accountSid }, () => 0), null);
  assert.equal(s.numbers.list(accountSid).length, 2, 'the collision wrote nothing');
});

/** The friendly name falls back to the number the allocator picked, not to blank. */
test('an allocated number is named after itself', () => {
  const { store: s, accountSid } = seeded();
  const number = s.numbers.createInAreaCode('212', { accountSid })!;
  assert.equal(number.friendlyName, number.phoneNumber);
  assert.equal(
    s.numbers.createInAreaCode('212', { accountSid, friendlyName: 'support' })!.friendlyName,
    'support',
  );
});

/* ------------------------------------------------------------------ messages */

/** A thread is **both directions**, oldest first — that is what makes it a conversation. */
test('a thread carries both directions in order', () => {
  const { store: s, accountSid } = seeded();
  s.messages.create({ accountSid, from: '+2', to: '+15550000001', body: 'in', direction: 'inbound' });
  s.messages.create({
    accountSid,
    from: '+15550000001',
    to: '+2',
    body: 'out',
    direction: 'outbound-reply',
  });
  const thread = s.messages.thread('+2', '+15550000001');
  assert.deepEqual(thread.map((m) => m.body), ['in', 'out']);
  // Unordered pair: who spoke first is not what identifies the conversation.
  assert.equal(s.messages.thread('+15550000001', '+2').length, 2);
});

/** A number's history is what it dialled *and* what it took, so both ends match. */
test('listing calls by number matches either end and excludes the rest', () => {
  const { store: s, accountSid } = seeded();
  s.calls.create({ sid: 'CA1', accountSid, from: '+2', to: '+15550000001', direction: 'inbound', status: 'completed' });
  s.calls.create({ sid: 'CA2', accountSid, from: '+15550000001', to: '+3', direction: 'outbound-api', status: 'completed' });
  s.calls.create({ sid: 'CA3', accountSid, from: '+4', to: '+5', direction: 'inbound', status: 'completed' });
  const mine = s.calls.list({ number: '+15550000001' });
  assert.deepEqual(mine.map((c) => c.sid).sort(), ['CA1', 'CA2']);
  assert.equal(s.calls.list({ number: '+15550000001', status: 'queued' }).length, 0);
});

test('threads can be narrowed to one number', () => {
  const { store: s, accountSid } = seeded();
  s.messages.create({ accountSid, from: '+2', to: '+15550000001', body: 'mine', direction: 'inbound' });
  s.messages.create({ accountSid, from: '+4', to: '+5', body: 'theirs', direction: 'inbound' });
  assert.equal(s.messages.threads().length, 2);
  const mine = s.messages.threads({ number: '+15550000001' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.lastBody, 'mine');
});

/**
 * The preview is the *newest* message, and an auto-reply lands in the same second as the
 * message it answers — so this is the case that a `MAX(created_at)` would get wrong half
 * the time. See the aggregate's comment in `messages.ts`.
 */
test('a thread previews its newest message, even within one second', () => {
  const { store: s, accountSid } = seeded();
  s.messages.create({ accountSid, from: '+2', to: '+15550000001', body: 'first', direction: 'inbound' });
  s.messages.create({
    accountSid,
    from: '+15550000001',
    to: '+2',
    body: 'the reply',
    direction: 'outbound-reply',
  });
  const [thread] = s.messages.threads();
  assert.equal(thread?.lastBody, 'the reply');
  assert.equal(thread?.lastFrom, '+15550000001');
  assert.equal(thread?.count, 2);
});

test('segment counting switches at the gsm-7 boundary', () => {
  assert.equal(segmentCount('x'.repeat(160)), 1);
  assert.equal(segmentCount('x'.repeat(161)), 2);
  assert.equal(segmentCount('é'.repeat(70)), 1);
  assert.equal(segmentCount('é'.repeat(71)), 2);
  assert.equal(segmentCount(''), 1);
});
