import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import { CALL_EVENTS, parseEventRequest, postCallStatus, wants } from './call-status.js';
import { Store } from './db/index.js';
import { WebhookPoster, type WebhookResult } from './webhook.js';

/**
 * `StatusCallbackEvent`, which is **Twilio's parameter and used to be dropped on the
 * floor**: `POST …/Calls.json` read `From`, `To`, `Url` and `StatusCallback` and ignored
 * everything else, so an application asking to hear about `ringing` heard nothing and
 * nothing said why.
 *
 * The default is the load-bearing part. Twilio's unnamed set is `completed` alone, which
 * is exactly what this app did before any of this existed — so the test that matters most
 * here is the one asserting an application that never heard of the parameter sees no
 * change at all.
 */

class Recorder extends WebhookPoster {
  readonly sent: Array<{ url: string; params: Record<string, string>; method: string }> = [];

  constructor() {
    super({ timeoutMs: 1000, logger: pino({ level: 'silent' }) });
  }

  override async post(
    url: string,
    _authToken: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<WebhookResult> {
    this.sent.push({ url, params, method });
    return { url, status: 200, body: '', params, method, durationMs: 0 };
  }
}

function fixture(events: string[] | null) {
  const store = Store.open({ path: ':memory:' });
  const account = store.accounts.create({ friendlyName: 'test' });
  const call = store.calls.create({
    accountSid: account.accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'queued',
    statusCallbackUrl: 'http://app.test/status',
    statusCallbackEvents: events,
  });
  const poster = new Recorder();
  const deps = { store, poster, logger: pino({ level: 'silent' }) };
  return { store, account, call, poster, deps };
}

test('an unnamed event set means completed, and only completed', () => {
  const { call } = fixture(null);
  assert.equal(wants(call, 'completed'), true);
  for (const event of CALL_EVENTS.filter((e) => e !== 'completed')) {
    assert.equal(wants(call, event), false, event);
  }
});

test('only the events a placement asked for are posted', async () => {
  const { call, poster, deps, account } = fixture(['initiated', 'completed']);

  for (const event of CALL_EVENTS) {
    await postCallStatus(deps, {
      call,
      event,
      status: event,
      authToken: account.authToken,
    });
  }

  assert.deepEqual(
    poster.sent.map((s) => s.params.CallStatus),
    ['initiated', 'completed'],
  );
});

/**
 * `SequenceNumber` is how an application orders callbacks that arrived out of order, so
 * it has to be one sequence per call — and this call's first event is posted from the
 * REST route while the rest come from the session. Two counters would restart it.
 */
test('SequenceNumber is one monotonic sequence across every poster', async () => {
  const { call, poster, deps, account } = fixture([...CALL_EVENTS]);

  for (const event of CALL_EVENTS) {
    await postCallStatus(deps, { call, event, status: event, authToken: account.authToken });
  }

  assert.deepEqual(
    poster.sent.map((s) => s.params.SequenceNumber),
    ['0', '1', '2', '3'],
  );
});

test('a status callback carries what Twilio sends on one', async () => {
  const { call, poster, deps, account } = fixture(['completed']);
  await postCallStatus(deps, {
    call,
    event: 'completed',
    status: 'busy',
    authToken: account.authToken,
    durationSeconds: 0,
  });

  const params = poster.sent[0]?.params ?? {};
  assert.equal(params.CallSid, call.sid);
  assert.equal(params.CallStatus, 'busy');
  assert.equal(params.CallDuration, '0');
  assert.equal(params.CallbackSource, 'call-progress-events');
  assert.equal(params.Caller, '+15550000001', 'both spellings, as on the voice webhook');
  assert.equal(params.Called, '+15559999999');
  assert.ok(params.Timestamp, 'and a timestamp');
  assert.doesNotThrow(() => new Date(params.Timestamp ?? '').toISOString(), 'a readable one');
});

test('nothing is posted when nobody named a url', async () => {
  const store = Store.open({ path: ':memory:' });
  const account = store.accounts.create({ friendlyName: 'test' });
  const call = store.calls.create({
    accountSid: account.accountSid,
    from: '+15550000001',
    to: '+15559999999',
    direction: 'outbound-api',
    status: 'queued',
  });
  const poster = new Recorder();
  await postCallStatus(
    { store, poster, logger: pino({ level: 'silent' }) },
    { call, event: 'completed', status: 'completed', authToken: account.authToken },
  );
  assert.deepEqual(poster.sent, []);
});

/* ------------------------------------------------- reading the parameter itself */

/**
 * A repeated form field arrives as an array and a single one as a string, because
 * `@fastify/formbody` parses with `querystring.parse`. Both shapes are what the SDK
 * actually sends, depending on how many events were asked for.
 */
test('StatusCallbackEvent is read in both the shapes a form can carry it', () => {
  assert.deepEqual(parseEventRequest('completed'), ['completed']);
  assert.deepEqual(parseEventRequest(['initiated', 'answered']), ['initiated', 'answered']);
  assert.deepEqual(parseEventRequest(['ANSWERED', ' ringing ']), ['answered', 'ringing']);
  assert.deepEqual(parseEventRequest(['completed', 'completed']), ['completed'], 'deduped');
});

/**
 * Unknown values are dropped rather than refused. Twilio adds event names over time, and
 * failing a call placement over one this build has not heard of is the worse answer.
 */
test('an unknown event name is dropped, not fatal', () => {
  assert.deepEqual(parseEventRequest(['completed', 'teleported']), ['completed']);
  assert.equal(parseEventRequest(['teleported']), null, 'nothing recognised reads as none named');
  assert.equal(parseEventRequest(undefined), null);
});
