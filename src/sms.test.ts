import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pino } from 'pino';
import twilio from 'twilio';
import { loadConfig } from './config.js';
import { Store } from './db/index.js';
import { signRequest } from './signature.js';
import { SmsService } from './sms.js';
import { WebhookPoster, type WebhookResult } from './webhook.js';

/**
 * Message status callbacks, which are **per message** and the sender's.
 *
 * Twilio takes `StatusCallback` on `POST …/Messages.json` and reports that message's
 * delivery to it, signed with the sending account's auth token. This file exists because
 * every part of that sentence was wrong here: the URL was read off the *destination*
 * number's row, it was signed with the *destination* account's token, and three of the
 * four ways a message can end reported nothing at all.
 *
 * The signature half is asserted against `twilio.validateRequest` — the real SDK's
 * verifier, which is what an application under test actually calls — for the same reason
 * `signature.test.ts` does: signing with the wrong token fails as a blanket 403 with
 * nothing naming why.
 */

interface Sent {
  url: string;
  authToken: string;
  params: Record<string, string>;
  method: string;
  kind?: string;
}

/**
 * A poster that records instead of sending, and answers what the test tells it to.
 *
 * Subclassed rather than mocked through an interface because `SmsService` takes the real
 * class; overriding the one method every path goes through keeps the seam honest.
 */
class Recorder extends WebhookPoster {
  readonly sent: Sent[] = [];
  reply: { status: number; body: string } = { status: 200, body: '<Response/>' };

  constructor() {
    super({ timeoutMs: 1000, logger: pino({ level: 'silent' }) });
  }

  override async post(
    url: string,
    authToken: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'POST',
    context: { kind?: string } = {},
  ): Promise<WebhookResult> {
    this.sent.push({ url, authToken, params, method, kind: context.kind });
    return {
      url,
      status: this.reply.status,
      body: this.reply.body,
      params,
      method,
      durationMs: 0,
    };
  }

  statuses(): Sent[] {
    return this.sent.filter((s) => s.kind === 'message-status');
  }
}

function fixture(): { store: Store; sms: SmsService; poster: Recorder } {
  const store = Store.open({ path: ':memory:' });
  const poster = new Recorder();
  const sms = new SmsService({
    store,
    poster,
    config: { ...loadConfig({}), dbPath: ':memory:' },
    logger: pino({ level: 'silent' }),
  });
  return { store, sms, poster };
}

/** Two accounts, so "the sender's token" and "the destination's token" differ. */
function twoParties(store: Store): { sender: string; recipient: string } {
  const senderAccount = store.accounts.create({ friendlyName: 'sender' });
  const recipientAccount = store.accounts.create({ friendlyName: 'recipient' });
  store.numbers.create({ phoneNumber: '+15550000001', accountSid: senderAccount.accountSid });
  store.numbers.create({
    phoneNumber: '+15550000002',
    accountSid: recipientAccount.accountSid,
    smsUrl: 'http://recipient.test/sms',
  });
  return { sender: senderAccount.accountSid, recipient: recipientAccount.accountSid };
}

test('a StatusCallback named on the send is where delivery is reported', async () => {
  const { store, sms, poster } = fixture();
  const { sender } = twoParties(store);

  const result = await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
    statusCallbackUrl: 'http://sender.test/status',
  });

  assert.equal(result.message.status, 'delivered');
  const statuses = poster.statuses();
  assert.equal(statuses.length, 1, 'exactly one status callback');
  assert.equal(statuses[0]?.url, 'http://sender.test/status');
  assert.equal(statuses[0]?.params.MessageStatus, 'delivered');
  assert.equal(statuses[0]?.params.SmsStatus, 'delivered', 'the older spelling too');
  assert.equal(statuses[0]?.params.MessageSid, result.message.sid);
  assert.equal(statuses[0]?.params.ErrorCode, undefined, 'no ErrorCode on a good delivery');
});

/**
 * **The bug this file was written for.** The callback describes the sender's own outbound
 * message, so it is signed with the sender's token. Signed with the destination's, the
 * real verifier rejects it — which is exactly what this asserts, in both directions.
 */
test('a status callback is signed with the sender account token, not the destination one', async () => {
  const { store, sms, poster } = fixture();
  const { sender, recipient } = twoParties(store);
  const senderToken = store.accounts.find(sender)?.authToken ?? '';
  const recipientToken = store.accounts.find(recipient)?.authToken ?? '';
  assert.notEqual(senderToken, recipientToken);

  await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
    statusCallbackUrl: 'http://sender.test/status',
  });

  const posted = poster.statuses()[0];
  assert.ok(posted);
  assert.equal(posted.authToken, senderToken);

  // Signed the way the poster would have, with the token it was actually handed, then
  // put to the verifier an application under test would call.
  const signature = signRequest(posted.authToken, posted.url, posted.params);
  assert.ok(
    twilio.validateRequest(senderToken, signature, posted.url, posted.params),
    'the real verifier accepts it under the sending account token',
  );
  assert.equal(
    twilio.validateRequest(recipientToken, signature, posted.url, posted.params),
    false,
    'and would reject it under the destination account token, which is what used to sign it',
  );
});

/**
 * Three of these four used to return before the single call site that reported anything,
 * so a message that went nowhere went quiet. A simulator exists to make that legible.
 */
test('every way a message can end reports a status', async () => {
  const cases: Array<{ name: string; to: string; setup: (s: Store) => void; status: string; errorCode?: string }> = [
    {
      name: 'a number this simulator does not hold',
      to: '+15557654321',
      setup: () => {},
      status: 'sent',
    },
    {
      name: 'a held number with no sms_url',
      to: '+15550000003',
      setup: (s) => {
        const account = s.accounts.create({ friendlyName: 'quiet' });
        s.numbers.create({ phoneNumber: '+15550000003', accountSid: account.accountSid });
      },
      status: 'delivered',
    },
  ];

  for (const c of cases) {
    const { store, sms, poster } = fixture();
    const account = store.accounts.create({ friendlyName: 'sender' });
    store.numbers.create({ phoneNumber: '+15550000001', accountSid: account.accountSid });
    c.setup(store);

    await sms.send({
      from: '+15550000001',
      to: c.to,
      body: 'hello',
      accountSid: account.accountSid,
      direction: 'outbound-api',
      statusCallbackUrl: 'http://sender.test/status',
    });

    const statuses = poster.statuses();
    assert.equal(statuses.length, 1, `${c.name}: reported`);
    assert.equal(statuses[0]?.params.MessageStatus, c.status, c.name);
  }
});

test('a webhook that refuses the message reports failed, with the error code', async () => {
  const { store, sms, poster } = fixture();
  const { sender } = twoParties(store);
  poster.reply = { status: 500, body: '' };

  const result = await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
    statusCallbackUrl: 'http://sender.test/status',
  });

  assert.equal(result.message.status, 'failed');
  const posted = poster.statuses()[0];
  assert.equal(posted?.params.MessageStatus, 'failed');
  assert.equal(posted?.params.ErrorCode, '30003', 'the code the row carries is the code sent');
});

test('a message with no StatusCallback posts nothing', async () => {
  const { store, sms, poster } = fixture();
  const { sender } = twoParties(store);

  await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
  });

  assert.deepEqual(poster.statuses(), [], 'nobody asked to be told');
});

/**
 * A `<Message>` that comes back in a webhook's TwiML is its own message going the other
 * way, not a further report on the one that prompted it. Inheriting the parent's callback
 * would tell the sender their message was delivered twice, the second time describing
 * somebody else's.
 */
test('a TwiML reply does not inherit the parent message status callback', async () => {
  const { store, sms, poster } = fixture();
  const { sender } = twoParties(store);
  poster.reply = { status: 200, body: '<Response><Message>hi back</Message></Response>' };

  const result = await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
    statusCallbackUrl: 'http://sender.test/status',
  });

  assert.ok(result.reply, 'the reply was delivered');
  assert.equal(result.reply?.statusCallbackUrl, null);
  assert.equal(poster.statuses().length, 1, 'one report, for the one message that asked');
});

/** The inbound webhook carries `SmsStatus`, which applications branch on. */
test('an inbound message webhook says it was received', async () => {
  const { store, sms, poster } = fixture();
  const { sender } = twoParties(store);

  await sms.send({
    from: '+15550000001',
    to: '+15550000002',
    body: 'hello',
    accountSid: sender,
    direction: 'outbound-api',
  });

  const inbound = poster.sent.find((s) => s.kind === 'message');
  assert.equal(inbound?.params.SmsStatus, 'received');
});

/* ------------------------------------------------------- the pool's inbound URL */

test("a pooled number answers at the service's URL, not its own", async () => {
  const { store, sms, poster } = fixture();
  const { recipient } = twoParties(store);
  const destination = store.numbers.findByNumber('+15550000002');
  assert.ok(destination);
  const service = store.messagingServices.create({
    accountSid: recipient,
    friendlyName: 'support',
    inboundRequestUrl: 'http://recipient.test/pool',
    inboundMethod: 'GET',
  });
  store.messagingServices.addNumber(service.sid, destination.sid);

  await sms.send({ from: '+15550000001', to: '+15550000002', body: 'hi' });

  const [inbound] = poster.sent.filter((s) => s.kind === 'message');
  assert.equal(inbound?.url, 'http://recipient.test/pool');
  assert.equal(inbound?.method, 'GET');
  // The application routing on this is how it tells one pool's traffic from another's.
  assert.equal(inbound?.params.MessagingServiceSid, service.sid);
});

test('a service with no inbound URL leaves the number answering where it did', async () => {
  const { store, sms, poster } = fixture();
  const { recipient } = twoParties(store);
  const destination = store.numbers.findByNumber('+15550000002');
  assert.ok(destination);
  const service = store.messagingServices.create({ accountSid: recipient, friendlyName: 'quiet' });
  store.messagingServices.addNumber(service.sid, destination.sid);

  await sms.send({ from: '+15550000001', to: '+15550000002', body: 'hi' });

  const [inbound] = poster.sent.filter((s) => s.kind === 'message');
  assert.equal(inbound?.url, 'http://recipient.test/sms');
  // Nothing to route on, so nothing is sent — a blank string reads as a service.
  assert.equal(inbound?.params.MessagingServiceSid, undefined);
});

/**
 * The arrangement a pool is most likely to be set up as: numbers with no `sms_url` of
 * their own, answered entirely through the service. Resolved below the `smsUrl` check
 * this is silently `delivered` and the handler never hears about it.
 */
test('a pooled number with no sms_url of its own is still delivered', async () => {
  const { store, sms, poster } = fixture();
  const account = store.accounts.create({ friendlyName: 'recipient' });
  store.numbers.create({ phoneNumber: '+15550000001', accountSid: account.accountSid });
  const bare = store.numbers.create({
    phoneNumber: '+15550000002',
    accountSid: account.accountSid,
  });
  const service = store.messagingServices.create({
    accountSid: account.accountSid,
    friendlyName: 'support',
    inboundRequestUrl: 'http://recipient.test/pool',
  });
  store.messagingServices.addNumber(service.sid, bare.sid);

  const result = await sms.send({ from: '+15550000001', to: '+15550000002', body: 'hi' });

  assert.equal(result.message.status, 'delivered');
  assert.equal(poster.sent.filter((s) => s.kind === 'message')[0]?.url, 'http://recipient.test/pool');
});

test("the pool's webhook is signed with the destination account's token", async () => {
  const { store, sms, poster } = fixture();
  const { recipient } = twoParties(store);
  const destination = store.numbers.findByNumber('+15550000002');
  assert.ok(destination);
  const service = store.messagingServices.create({
    accountSid: recipient,
    friendlyName: 'support',
    inboundRequestUrl: 'http://recipient.test/pool',
  });
  store.messagingServices.addNumber(service.sid, destination.sid);

  await sms.send({ from: '+15550000001', to: '+15550000002', body: 'hi' });

  const [inbound] = poster.sent.filter((s) => s.kind === 'message');
  assert.ok(inbound);
  const token = store.accounts.find(recipient)?.authToken;
  assert.equal(inbound.authToken, token);
  // Signed over the *service's* URL, which is the one it was posted to.
  assert.ok(
    twilio.validateRequest(
      token ?? '',
      signRequest(token ?? '', inbound.url, inbound.params),
      inbound.url,
      inbound.params,
    ),
  );
});
