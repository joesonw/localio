import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import type { CallFeedEvent } from '../call-feed.js';
import { loadConfig } from '../config.js';
import { Store } from '../db/index.js';
import { LocalioServer } from '../server.js';

/**
 * The properties of the mock REST API that are **silent when wrong**.
 *
 * Every one of these fails as something other than what it is: a form body that is not
 * read answers 415 and reads as a Twilio outage; a camelCase response deserializes into a
 * resource whose every optional field is `undefined`; an ISO 8601 timestamp becomes an
 * `Invalid Date` inside the SDK without a word. `signature.test.ts` covers the other
 * failure of this kind.
 */

const API = '/2010-04-01';

async function fixture(logger = pino({ level: 'silent' })): Promise<{
  server: LocalioServer;
  store: Store;
  accountSid: string;
  auth: string;
}> {
  const store = Store.open({ path: ':memory:' });
  const account = store.accounts.create({ friendlyName: 'test' });
  store.numbers.create({ phoneNumber: '+15550000001', accountSid: account.accountSid });
  const config = { ...loadConfig({}), dbPath: ':memory:' };
  const server = new LocalioServer({ store, config, logger });
  await server.app.ready();
  return {
    server,
    store,
    accountSid: account.accountSid,
    auth: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString('base64')}`,
  };
}

/** **`@fastify/formbody` is not optional.** Without it every route here answers 415. */
test('a form-encoded body is read at all', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001&To=%2B15559999999&Url=http%3A%2F%2Fapp.test%2Fvoice',
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  assert.equal(body.from, '+15550000001');
  assert.equal(body.status, 'queued');
  await server.close();
});

/**
 * **Snake_case.** The SDK camelCases these itself, so answering `friendlyName` produces a
 * resource whose `friendlyName` is `undefined` — and nothing says so.
 */
test('responses are snake_case', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'PhoneNumber=%2B15550000002&FriendlyName=second&VoiceUrl=http%3A%2F%2Fapp.test%2Fv',
  });
  const body = response.json();
  assert.equal(response.statusCode, 201);
  assert.ok('friendly_name' in body, 'friendly_name must be snake_case');
  assert.ok('phone_number' in body);
  assert.ok('voice_url' in body);
  assert.equal(body.friendly_name, 'second');
  assert.ok(!('friendlyName' in body), 'camelCase must not appear');
  await server.close();
});

/** Provisioning **actually creates a number** here, unlike the app this came from. */
test('a provisioned number is one this simulator really holds', async () => {
  const { server, store, accountSid, auth } = await fixture();
  await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'PhoneNumber=%2B15550000002',
  });
  assert.notEqual(store.numbers.findByNumber('+15550000002'), null);
  await server.close();
});

/**
 * **RFC 2822, and `duration` is a string.** An ISO 8601 date becomes an `Invalid Date`
 * inside the SDK, silently; a numeric duration is not what its deserializer expects.
 */
test('timestamps are rfc 2822 and duration is a string', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const call = store.calls.create({
    accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'completed',
  });
  store.calls.markInProgress(call.sid);
  store.calls.finish(call.sid, 'completed');
  const body = (
    await server.app.inject({
      url: `${API}/Accounts/${accountSid}/Calls/${call.sid}.json`,
      headers: { authorization: auth },
    })
  ).json();
  assert.ok(!Number.isNaN(Date.parse(body.date_created)), 'date_created must parse');
  assert.match(body.date_created, /GMT$/, 'must be rfc 2822, not iso 8601');
  assert.equal(typeof body.duration, 'string');
  // Null rather than plausible: nothing here can know a price.
  assert.equal(body.price, null);
  assert.equal(body.answered_by, null);
  await server.close();
});

/** `duration` is **empty**, not `"0"`, while a call is still up. */
test('a queued call has an empty duration and no start time', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const call = store.calls.create({
    accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'queued',
  });
  const body = (
    await server.app.inject({
      url: `${API}/Accounts/${accountSid}/Calls/${call.sid}.json`,
      headers: { authorization: auth },
    })
  ).json();
  assert.equal(body.duration, '');
  assert.equal(body.start_time, null);
  await server.close();
});

/** **Reading a queued call leaves it answerable.** Looking at one must not consume it. */
test('fetching a queued call does not take it', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const call = store.calls.create({
    accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'queued',
  });
  await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls/${call.sid}.json`,
    headers: { authorization: auth },
  });
  assert.notEqual(store.calls.answer(call.sid), null, 'the call must still be answerable');
  await server.close();
});

/** **Twilio's error shape**, or an SDK reports a missing call as a provider outage. */
test('an unknown sid is a 20404 in Twilio\'s shape', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls/CA${'0'.repeat(32)}.json`,
    headers: { authorization: auth },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json();
  assert.equal(body.code, 20404);
  assert.equal(body.status, 404);
  assert.ok(typeof body.message === 'string' && body.message.length > 0);
  await server.close();
});

/**
 * **An unfaked route is a 501, not a 404.** Pointing a client here redirects its whole API
 * domain; a 404 would read as the resource not existing rather than as a gap in this tool.
 */
test('an unfaked route answers 20501 and names the path', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Conferences.json`,
    headers: { authorization: auth },
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().code, 20501);
  assert.match(response.json().message, /Conferences\.json/);
  await server.close();
});

/** The catch-all must be **last**: a real route in front of it still answers. */
test('the catch-all does not swallow real routes', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    headers: { authorization: auth },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().incoming_phone_numbers.length, 1);
  await server.close();
});

/* ---------------------------------------------------------------------- auth */

test('a request with no credentials is refused', async () => {
  const { server, accountSid } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 20003);
  await server.close();
});

test('a wrong auth token is refused', async () => {
  const { server, accountSid } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:not-the-token`).toString('base64')}`,
    },
  });
  assert.equal(response.statusCode, 401);
  await server.close();
});

test('an unknown account is a 20404, not a 401', async () => {
  const { server } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/AC${'9'.repeat(32)}/Calls.json`,
    headers: { authorization: `Basic ${Buffer.from('x:y').toString('base64')}` },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, 20404);
  await server.close();
});

/* ------------------------------------------------------------------ api keys */

/** Basic with `SK…`, which is what `twilio(keySid, keySecret, { accountSid })` sends. */
function keyAuth(sid: string, secret: string): string {
  return `Basic ${Buffer.from(`${sid}:${secret}`).toString('base64')}`;
}

test('an api key of the account authenticates', async () => {
  const { server, store, accountSid } = await fixture();
  const key = store.apiKeys.create({ accountSid });
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: keyAuth(key.sid, key.secret) },
  });
  assert.equal(response.statusCode, 200, response.body);
  await server.close();
});

test('a wrong key secret is refused', async () => {
  const { server, store, accountSid } = await fixture();
  const key = store.apiKeys.create({ accountSid });
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: keyAuth(key.sid, 'not-the-secret') },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 20003);
  await server.close();
});

/**
 * A key of another account is a **401**, not a 404: the account in the path exists, and
 * the credential simply does not open it. Answering 404 would say the account is gone.
 */
test('a key of another account does not open this one', async () => {
  const { server, store, accountSid } = await fixture();
  const other = store.accounts.create({ friendlyName: 'other' });
  const key = store.apiKeys.create({ accountSid: other.accountSid });
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: keyAuth(key.sid, key.secret) },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 20003);
  await server.close();
});

/** `Keys.json` is faked rather than left to the 20501 catch-all. */
test('creating a key answers the secret once, and reads never do', async () => {
  const { server, accountSid, auth } = await fixture();
  const created = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Keys.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'FriendlyName=ci',
  });
  assert.equal(created.statusCode, 201, created.body);
  const key = created.json();
  assert.match(key.sid, /^SK[0-9a-f]{32}$/);
  assert.equal(key.friendly_name, 'ci');
  assert.equal(typeof key.secret, 'string');
  // RFC 2822, like every other timestamp here — an ISO string is an `Invalid Date` in the SDK.
  assert.ok(!Number.isNaN(new Date(key.date_created).getTime()));

  const read = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Keys/${key.sid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().sid, key.sid);
  assert.ok(!('secret' in read.json()), 'a read must not answer the secret');

  const list = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Keys.json`,
    headers: { authorization: auth },
  });
  assert.deepEqual(
    list.json().keys.map((row: { sid: string }) => row.sid),
    [key.sid],
  );
  await server.close();
});

test('a key is renamed with a POST and deleted with a DELETE', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const key = store.apiKeys.create({ accountSid, friendlyName: 'before' });
  const renamed = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Keys/${key.sid}.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'FriendlyName=after',
  });
  assert.equal(renamed.json().friendly_name, 'after');

  const removed = await server.app.inject({
    method: 'DELETE',
    url: `${API}/Accounts/${accountSid}/Keys/${key.sid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(removed.statusCode, 204);

  const gone = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Keys/${key.sid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().code, 20404);
  await server.close();
});

/** Across an account boundary a key does not exist, which is what Twilio says too. */
test('another account\'s key is a 20404 on the by-sid routes', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const other = store.accounts.create({ friendlyName: 'other' });
  const key = store.apiKeys.create({ accountSid: other.accountSid });
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Keys/${key.sid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, 20404);
  await server.close();
});

/* ---------------------------------------------------------------- recordings */

/** **`.mp3` answers 501** rather than serving a WAV under a name that will not decode. */
test('an mp3 recording is refused rather than mislabelled', async () => {
  const { server, store, accountSid } = await fixture();
  const call = store.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'inbound',
    status: 'completed',
  });
  const sid = store.recordings.mint();
  store.recordings.create({
    sid,
    callSid: call.sid,
    accountSid,
    path: '/nonexistent.wav',
    durationSec: 1,
  });
  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Recordings/${sid}.mp3`,
  });
  assert.equal(response.statusCode, 501);
  assert.equal(response.json().code, 20501);
  await server.close();
});

/** A row whose file is gone is a 404, not a stream of nothing. */
test('a recording whose file is missing is a 404', async () => {
  const { server, store, accountSid } = await fixture();
  const call = store.calls.create({
    accountSid,
    from: '+1',
    to: '+2',
    direction: 'inbound',
    status: 'completed',
  });
  const sid = store.recordings.mint();
  store.recordings.create({
    sid,
    callSid: call.sid,
    accountSid,
    path: '/nonexistent.wav',
    durationSec: 1,
  });
  const response = await server.app.inject({ url: `${API}/Accounts/${accountSid}/Recordings/${sid}` });
  assert.equal(response.statusCode, 404);
  await server.close();
});

/* ------------------------------------------------------------------ messages */

/**
 * **The `SM…` answered is the `SM…` recorded.** That sid is what an application stores as
 * its own message id; a second mint in the route would leave the record and the answer as
 * two messages that merely look alike.
 */
test('the sid answered to Messages.json is the one in the store', async () => {
  const { server, store, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Messages.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001&To=%2B15559999999&Body=hello',
  });
  assert.equal(response.statusCode, 201);
  const sid = response.json().sid;
  assert.match(sid, /^SM[0-9a-f]{32}$/);
  assert.equal(store.messages.find(sid)?.body, 'hello');
  await server.close();
});

/** `queued` is what a real `Messages.json` can say synchronously, and all this claims. */
test('Messages.json answers queued whatever happened afterwards', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Messages.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001&To=%2B15559999999&Body=hello',
  });
  assert.equal(response.json().status, 'queued');
  assert.equal(typeof response.json().num_segments, 'string');
  await server.close();
});

test('a message with no body is refused in Twilio\'s shape', async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Messages.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001&To=%2B15559999999',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 21602);
  await server.close();
});


/**
 * **The access log is scoped by hand, and nothing else would catch it if it were not.**
 *
 * The hooks live on the instance `/admin` and `/api` are registered on, so a missing
 * prefix test logs the Phone panel's polling — every existing test still passes, and the
 * terminal becomes useless exactly when a call is up. This asserts the scope, and that the
 * `501` catch-all is a `warn`: an unfaked path is the one line here worth interrupting for.
 */
test('the access log covers /2010-04-01 and nothing else', async () => {
  const lines: { level: number; msg: string; url?: string; status?: number }[] = [];
  const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  const { server, accountSid, auth } = await fixture(logger);

  await server.app.inject({
    method: 'GET',
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: auth },
  });
  await server.app.inject({ method: 'GET', url: '/api/settings' });
  await server.app.inject({
    method: 'GET',
    url: `${API}/Accounts/${accountSid}/Queues.json`,
    headers: { authorization: auth },
  });

  const access = lines.filter((line) => line.msg === 'twilio api');
  assert.equal(access.length, 2, 'one line per /2010-04-01 request, and none for /api');
  assert.ok(!access.some((line) => line.url?.startsWith('/api')));
  assert.equal(access[0]?.status, 200);
  assert.equal(access[0]?.level, 30, 'an ordinary request is info');
  assert.equal(access[1]?.status, 501);
  assert.equal(access[1]?.level, 40, 'a path localio does not fake is warn');
  await server.close();
});

/* --------------------------------------------------------------- subaccounts */

const basic = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const FORM = 'application/x-www-form-urlencoded';

/** Create a subaccount over REST and hand back its sid and token. */
async function subaccount(
  server: LocalioServer,
  auth: string,
  friendlyName = 'tenant-a',
): Promise<{ sid: string; token: string }> {
  const created = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: `FriendlyName=${friendlyName}`,
  });
  assert.equal(created.statusCode, 201, created.body);
  return { sid: created.json().sid, token: created.json().auth_token };
}

test('creating a subaccount answers a Twilio-shaped account', async () => {
  const { server, accountSid, auth } = await fixture();
  const created = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'FriendlyName=tenant-a',
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json();
  assert.match(body.sid, /^AC[0-9a-f]{32}$/);
  assert.equal(body.owner_account_sid, accountSid, 'the parent owns it');
  assert.equal(body.status, 'active');
  assert.equal(body.type, 'Full');
  assert.equal(typeof body.auth_token, 'string', 'the token is the point of creating one');
  assert.ok('friendly_name' in body, 'friendly_name must be snake_case');
  assert.ok(!('friendlyName' in body), 'camelCase must not appear');
  assert.equal(body.uri, `${API}/Accounts/${body.sid}.json`);
  assert.equal(body.subresource_uris.calls, `${API}/Accounts/${body.sid}/Calls.json`);
  // A top-level account owns itself, which is what the SDK's callers branch on.
  const parent = await server.app.inject({
    url: `${API}/Accounts/${accountSid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(parent.json().owner_account_sid, accountSid);
  await server.close();
});

/**
 * **The invariant this whole feature turns on.**
 *
 * A parent's credentials at a child's path place the *child's* call. If `authenticate`
 * ever returned the credential's account instead of the path's, the row would be the
 * parent's and its webhooks would be signed with the parent's token — which the Twilio
 * SDK's validator rejects with nothing naming why.
 */
test("a parent's credentials open a child, and the resource stays the child's", async () => {
  const { server, auth } = await fixture();
  const child = await subaccount(server, auth);

  const placed = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${child.sid}/Calls.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'From=%2B15550000001&To=%2B15550000002',
  });
  assert.equal(placed.statusCode, 201, placed.body);
  assert.equal(placed.json().account_sid, child.sid, 'the call belongs to the subaccount');

  // And the child's own credentials reach it too.
  const own = await server.app.inject({
    url: `${API}/Accounts/${child.sid}/Calls.json`,
    headers: { authorization: basic(child.sid, child.token) },
  });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.json().calls.map((call: { sid: string }) => call.sid), [placed.json().sid]);
  await server.close();
});

/** The relationship runs one way only: a child's credentials do not open its parent. */
test("a child's credentials do not open its parent", async () => {
  const { server, accountSid, auth } = await fixture();
  const child = await subaccount(server, auth);

  const response = await server.app.inject({
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: basic(child.sid, child.token) },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 20003);
  await server.close();
});

/** Nor does a sibling's — two children of one parent are strangers to each other. */
test("a sibling's credentials do not open a subaccount", async () => {
  const { server, auth } = await fixture();
  const first = await subaccount(server, auth, 'first');
  const second = await subaccount(server, auth, 'second');

  const response = await server.app.inject({
    url: `${API}/Accounts/${second.sid}.json`,
    headers: { authorization: basic(first.sid, first.token) },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, 20003);
  await server.close();
});

/** `status` is stored *and enforced*, which is the only thing that makes it worth storing. */
test('a suspended subaccount opens nothing, with either credential', async () => {
  const { server, auth } = await fixture();
  const child = await subaccount(server, auth);

  const suspended = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${child.sid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'Status=suspended',
  });
  assert.equal(suspended.statusCode, 200, suspended.body);
  assert.equal(suspended.json().status, 'suspended');

  for (const header of [auth, basic(child.sid, child.token)]) {
    const response = await server.app.inject({
      url: `${API}/Accounts/${child.sid}/Calls.json`,
      headers: { authorization: header },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 20005, 'a non-active account is a 20005');
  }

  // And it comes back.
  await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${child.sid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'Status=active',
  });
  const revived = await server.app.inject({
    url: `${API}/Accounts/${child.sid}/Calls.json`,
    headers: { authorization: basic(child.sid, child.token) },
  });
  assert.equal(revived.statusCode, 200);
  await server.close();
});

/** Suspending the top-level account would shut the REST API out of itself. */
test("a top-level account's status cannot be changed over REST", async () => {
  const { server, accountSid, auth } = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'Status=suspended',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 20001);
  // Renaming it is still fine.
  const renamed = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'FriendlyName=renamed',
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().friendly_name, 'renamed');
  await server.close();
});

/** **One level, strictly.** */
test('a subaccount cannot create a subaccount', async () => {
  const { server, auth } = await fixture();
  const child = await subaccount(server, auth);

  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts.json`,
    headers: { authorization: basic(child.sid, child.token), 'content-type': FORM },
    payload: 'FriendlyName=grandchild',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 20001);
  await server.close();
});

/** The listing is the authenticated account plus its children, and `Status` narrows it. */
test('listing accounts answers self and subaccounts', async () => {
  const { server, accountSid, auth } = await fixture();
  const first = await subaccount(server, auth, 'first');
  const second = await subaccount(server, auth, 'second');

  const list = await server.app.inject({
    url: `${API}/Accounts.json`,
    headers: { authorization: auth },
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    list.json().accounts.map((account: { sid: string }) => account.sid),
    [accountSid, first.sid, second.sid],
  );

  await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${second.sid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'Status=closed',
  });
  const closed = await server.app.inject({
    url: `${API}/Accounts.json?Status=closed`,
    headers: { authorization: auth },
  });
  assert.deepEqual(
    closed.json().accounts.map((account: { sid: string }) => account.sid),
    [second.sid],
  );

  // A child listing is just itself — nothing rolls up or down.
  const childList = await server.app.inject({
    url: `${API}/Accounts.json`,
    headers: { authorization: basic(first.sid, first.token) },
  });
  assert.deepEqual(
    childList.json().accounts.map((account: { sid: string }) => account.sid),
    [first.sid],
  );
  await server.close();
});

/** An API key of the parent is a parent credential, and opens the child the same way. */
test("a parent's API key opens a subaccount", async () => {
  const { server, store, accountSid, auth } = await fixture();
  const child = await subaccount(server, auth);
  const key = store.apiKeys.create({ accountSid, friendlyName: 'ci' });

  const response = await server.app.inject({
    url: `${API}/Accounts/${child.sid}.json`,
    headers: { authorization: basic(key.sid, key.secret) },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().sid, child.sid);
  await server.close();
});

/** A sid nothing knows is still a 20404, not an auth failure. */
test('an unknown account sid is a 20404', async () => {
  const { server, auth } = await fixture();
  const response = await server.app.inject({
    url: `${API}/Accounts/AC${'9'.repeat(32)}.json`,
    headers: { authorization: auth },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().code, 20404);
  await server.close();
});

/**
 * A suspended account cannot present its **own** credentials to revive itself — only an
 * active parent can. Otherwise `suspended` would be a state its holder could simply leave.
 */
test('a suspended subaccount cannot un-suspend itself', async () => {
  const { server, auth } = await fixture();
  const child = await subaccount(server, auth);
  await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${child.sid}.json`,
    headers: { authorization: auth, 'content-type': FORM },
    payload: 'Status=suspended',
  });

  const own = basic(child.sid, child.token);
  for (const injection of [
    { url: `${API}/Accounts/${child.sid}.json`, headers: { authorization: own } },
    {
      method: 'POST' as const,
      url: `${API}/Accounts/${child.sid}.json`,
      headers: { authorization: own, 'content-type': FORM },
      payload: 'Status=active',
    },
  ]) {
    const response = await server.app.inject(injection);
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().code, 20005);
  }

  // The parent can still read it, which is how you find out why it stopped.
  const read = await server.app.inject({
    url: `${API}/Accounts/${child.sid}.json`,
    headers: { authorization: auth },
  });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().status, 'suspended');
  await server.close();
});

/**
 * A placed call is pushed, not only stored.
 *
 * The row is left `queued` for the Phone panel to pick up, and without this the panel does
 * not know it exists until its next two-second poll. Advisory: the poll is still what
 * heals a page that was not listening, and `Calls.answer()` is still what makes the pickup
 * happen once.
 */
test('placing a call announces it on the feed', async () => {
  const { server, accountSid, auth } = await fixture();
  const seen: CallFeedEvent[] = [];
  server.feed.subscribe({ event: (event) => seen.push(event) });

  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001&To=%2B15559999999&Url=http%3A%2F%2Flocalhost%3A3000%2Fvoice',
  });
  assert.equal(response.statusCode, 201);

  assert.deepEqual(
    seen.map((e) => e.kind),
    ['ringing'],
  );
  // The same `CA…` the caller was just answered with — never a second mint.
  assert.equal(seen[0]?.call.sid, response.json().sid);
  assert.equal(seen[0]?.call.status, 'queued');
  assert.equal(seen[0]?.claimedBy, null);
});

/** A refused placement is not a call, so nothing is pushed for it. */
test('a placement that was refused announces nothing', async () => {
  const { server, accountSid, auth } = await fixture();
  const seen: CallFeedEvent[] = [];
  server.feed.subscribe({ event: (event) => seen.push(event) });

  const response = await server.app.inject({
    method: 'POST',
    url: `${API}/Accounts/${accountSid}/Calls.json`,
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'From=%2B15550000001',
  });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(seen, []);
});
