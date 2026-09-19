import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Account, AccountStatus, ApiKey, MessagingService, PhoneNumber, Store } from '../db/index.js';

/**
 * Managing the simulator itself: the accounts it holds, the API keys that open them and
 * the numbers it answers for.
 *
 * This is what replaces the extracted app's org / number / credential pickers, which read
 * three tables out of another deployment's Postgres. Here the numbers are `localio`'s own
 * rows, and this is the one way they get created without a Twilio client.
 *
 * **Secrets are not in a listing.** `GET /admin/accounts` omits every `auth_token` and
 * `GET /admin/keys` every `secret`; the two `?reveal=1` reads are the only ones in the
 * whole app that return them — they exist because the credential has to be pasted into
 * the application under test, and they are separate so that it is not sitting in every
 * poll of the Admin panel.
 *
 * **Nothing here is authenticated**, which is why the server listens on `127.0.0.1` and
 * warns when told not to. A route that hands out auth tokens is not one to widen.
 */

const urlOrNull = z
  .string()
  .max(2048)
  .nullable()
  .optional()
  .refine(
    (value) => value === undefined || value === null || value === '' || parses(value),
    'must be an absolute http(s) url',
  )
  // A blank box in the UI means "clear it", which is `null` in the store — the
  // distinction `PhoneNumbers.update` keeps from `undefined`, which means "not mentioned".
  .transform((value) => (value === '' ? null : value));

const method = z.enum(['GET', 'POST']).optional();

/** E.164: a plus, a non-zero country digit, then digits. What Twilio will accept. */
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 number like +15551234567');

const accountSid = z.string().regex(/^AC[0-9a-f]{32}$/);

const accountBody = z.object({
  friendly_name: z.string().max(200).optional(),
  account_sid: accountSid.optional(),
  auth_token: z.string().min(1).max(256).optional(),
  /** Blank or absent means a top-level account. Only a top-level account may be named. */
  parent_account_sid: accountSid.nullable().optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
});

/**
 * The sid and the parent are both fixed at creation.
 *
 * Both are omitted **and the schema is `.strict()`**, because zod's default is to strip an
 * unrecognized key rather than complain: without it a PATCH naming a parent would answer
 * `200` and change nothing, which is the silent no-op this omission exists to prevent.
 * `Accounts.upsert` will not reparent either — this is the half that says so out loud.
 */
const accountPatch = accountBody
  .partial()
  .omit({ account_sid: true, parent_account_sid: true })
  .strict();

const numberBody = z.object({
  phone_number: e164,
  account_sid: z.string().min(1),
  friendly_name: z.string().max(200).optional(),
  voice_url: urlOrNull,
  voice_method: method,
  status_callback_url: urlOrNull,
  status_callback_method: method,
  sms_url: urlOrNull,
  sms_method: method,
});

const numberPatch = numberBody.partial().omit({ phone_number: true });

/**
 * An API key: a second credential for an account.
 *
 * The sid and the secret may be pinned here, the way an account's may be, so a key an
 * application already carries in its own configuration can be reproduced. The REST
 * `Keys.json` route accepts neither — Twilio does not.
 */
const keyBody = z.object({
  account_sid: z.string().min(1),
  friendly_name: z.string().max(200).optional(),
  sid: z.string().regex(/^SK[0-9a-f]{32}$/).optional(),
  secret: z.string().min(1).max(256).optional(),
});

/** The name is the only thing about a key that changes; the account and the secret do not. */
const keyPatch = keyBody.partial().pick({ friendly_name: true });

/**
 * A Messaging Service: a pool of numbers that sends as one sender.
 *
 * `phone_numbers` states the pool in E.164 rather than in `PN…`, because that is what a
 * person writing a seed file or filling in this form actually knows.
 */
const messagingServiceBody = z.object({
  account_sid: z.string().min(1),
  friendly_name: z.string().max(200).optional(),
  sid: z.string().regex(/^MG[0-9a-f]{32}$/).optional(),
  inbound_request_url: urlOrNull,
  inbound_method: method,
  status_callback_url: urlOrNull,
  phone_numbers: z.array(e164).optional(),
});

/**
 * The account is fixed at creation, the way an account's parent is — a pool is one
 * account's, because `sms.ts` signs a pooled delivery with that one account's token.
 * `.strict()` for the same reason `accountPatch` is: a PATCH naming it must say so rather
 * than answer `200` and change nothing.
 */
const messagingServicePatch = messagingServiceBody
  .partial()
  .omit({ sid: true, account_sid: true, phone_numbers: true })
  .strict();

/** Which number to put in a pool, or take out of one. */
const poolBody = z.object({
  phone_number_sid: z.string().regex(/^PN[0-9a-f]{32}$/),
});

/** Accounts, numbers and services — the shape of the seed file and of `POST /admin/seed`. */
export const seedSchema = z.object({
  accounts: z.array(accountBody.extend({ account_sid: z.string().optional() })).default([]),
  numbers: z.array(numberBody.partial({ account_sid: true })).default([]),
  messaging_services: z
    .array(messagingServiceBody.partial({ account_sid: true }))
    .default([]),
});

export type Seed = z.infer<typeof seedSchema>;

function parses(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function accountView(account: Account, store: Store, reveal = false): Record<string, unknown> {
  return {
    account_sid: account.accountSid,
    friendly_name: account.friendlyName,
    parent_account_sid: account.parentAccountSid,
    status: account.status,
    number_count: store.accounts.numberCount(account.accountSid),
    key_count: store.accounts.keyCount(account.accountSid),
    subaccount_count: store.accounts.subaccountCount(account.accountSid),
    created_at: account.createdAt,
    ...(reveal ? { auth_token: account.authToken } : {}),
  };
}

export function numberView(number: PhoneNumber): Record<string, unknown> {
  return {
    sid: number.sid,
    account_sid: number.accountSid,
    phone_number: number.phoneNumber,
    friendly_name: number.friendlyName,
    voice_url: number.voiceUrl,
    voice_method: number.voiceMethod,
    status_callback_url: number.statusCallbackUrl,
    status_callback_method: number.statusCallbackMethod,
    sms_url: number.smsUrl,
    sms_method: number.smsMethod,
    created_at: number.createdAt,
  };
}

/**
 * A service and its pool in one object.
 *
 * The pool is inlined rather than left to a second request because the Admin panel draws
 * the chips from the same two-second poll that draws the card, and a second round trip per
 * card is how a list of ten becomes eleven requests a tick.
 */
export function messagingServiceView(
  service: MessagingService,
  store: Store,
): Record<string, unknown> {
  return {
    sid: service.sid,
    account_sid: service.accountSid,
    friendly_name: service.friendlyName,
    inbound_request_url: service.inboundRequestUrl,
    inbound_method: service.inboundMethod,
    status_callback_url: service.statusCallbackUrl,
    phone_numbers: store.messagingServices
      .numbers(service.sid)
      .map((number) => ({ sid: number.sid, phone_number: number.phoneNumber })),
    created_at: service.createdAt,
    updated_at: service.updatedAt,
  };
}

export function keyView(key: ApiKey, reveal = false): Record<string, unknown> {
  return {
    sid: key.sid,
    account_sid: key.accountSid,
    friendly_name: key.friendlyName,
    created_at: key.createdAt,
    updated_at: key.updatedAt,
    ...(reveal ? { secret: key.secret } : {}),
  };
}

/**
 * Why a named parent will not do, or `null` if it will.
 *
 * Two refusals, both 400: the parent has to exist, and it has to be top-level. **One
 * level, strictly** — the same rule `POST /2010-04-01/Accounts.json` holds, and it lives
 * in the routes rather than the schema because only here is there somewhere to say why.
 */
function parentRefusal(
  store: Store,
  parentAccountSid: string | null | undefined,
): { error: string; message: string } | null {
  if (!parentAccountSid) return null;
  const parent = store.accounts.find(parentAccountSid);
  if (parent === null) {
    return {
      error: 'no_such_account',
      message: `${parentAccountSid} is not an account this simulator holds`,
    };
  }
  if (parent.parentAccountSid !== null) {
    return {
      error: 'not_a_parent',
      message: `${parentAccountSid} is itself a subaccount, and a subaccount cannot hold subaccounts`,
    };
  }
  return null;
}

/**
 * Why a number will not go in this pool, or `null` if it will.
 *
 * Two refusals. **A pool is one account's** — `sms.ts` signs a pooled delivery with the
 * one account's token, and a member from elsewhere would be delivered signed with a token
 * the application under test does not verify with, which is a blanket 403 at the far end
 * with nothing naming why. And **a number is in at most one service**, which is Twilio's
 * own rule and what makes inbound resolution a single answer; the refusal names the `MG…`
 * in the way, the way the numbers' `exists` names the `PN…`.
 */
function poolRefusal(
  store: Store,
  accountSid: string,
  phoneNumber: string,
  serviceSid?: string,
): { code: number; body: { error: string; message: string } } | null {
  const number = store.numbers.findByNumber(phoneNumber);
  if (!number) {
    return {
      code: 400,
      body: {
        error: 'no_such_number',
        message: `${phoneNumber} is not a number this simulator holds`,
      },
    };
  }
  if (number.accountSid !== accountSid) {
    return {
      code: 400,
      body: {
        error: 'wrong_account',
        message: `${phoneNumber} is held by ${number.accountSid}, and a pool is one account's`,
      },
    };
  }
  const holder = store.messagingServices.findForNumber(number.sid);
  if (holder && holder.sid !== serviceSid) {
    return {
      code: 409,
      body: {
        error: 'in_another_service',
        message: `${phoneNumber} is already in messaging service ${holder.sid}`,
      },
    };
  }
  return null;
}

function invalid(reply: FastifyReply, error: z.ZodError): void {
  void reply.code(400).send({
    error: 'invalid_request',
    // The field and the reason, rather than a wall of zod. The Admin panel prints this
    // next to the box, so it has to read as a sentence.
    message: error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; '),
  });
}

export function registerAdmin(app: FastifyInstance, store: Store): void {
  /* --------------------------------------------------------------- accounts */

  app.get('/admin/accounts', async () => ({
    accounts: store.accounts.list().map((account) => accountView(account, store)),
  }));

  app.get('/admin/accounts/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const account = store.accounts.find(sid);
    if (account === null) return reply.code(404).send({ error: 'not_found' });
    const { reveal } = request.query as { reveal?: string };
    return accountView(account, store, reveal === '1' || reveal === 'true');
  });

  /** The sid and the token are minted by the store unless the body pins them. */
  app.post('/admin/accounts', async (request, reply) => {
    const parsed = accountBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    if (parsed.data.account_sid && store.accounts.find(parsed.data.account_sid)) {
      return reply.code(409).send({ error: 'exists', message: 'that account sid is already held' });
    }
    const refusal = parentRefusal(store, parsed.data.parent_account_sid);
    if (refusal) return reply.code(400).send(refusal);
    const account = store.accounts.create({
      friendlyName: parsed.data.friendly_name,
      accountSid: parsed.data.account_sid,
      authToken: parsed.data.auth_token,
      parentAccountSid: parsed.data.parent_account_sid,
      status: parsed.data.status,
    });
    // The token is in this one answer, because the whole point of creating an account is
    // to get it and paste it into the application under test.
    return reply.code(201).send(accountView(account, store, true));
  });

  app.patch('/admin/accounts/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const parsed = accountPatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const account = store.accounts.update(sid, {
      friendlyName: parsed.data.friendly_name,
      authToken: parsed.data.auth_token,
      status: parsed.data.status,
    });
    if (account === null) return reply.code(404).send({ error: 'not_found' });
    return accountView(account, store);
  });

  /**
   * Refused while the account still holds numbers, with the count in the message.
   *
   * The foreign key would refuse it anyway, with `SQLITE_CONSTRAINT` and nothing naming
   * what was in the way. Saying how many is what makes the refusal actionable.
   */
  app.delete('/admin/accounts/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const outcome = store.accounts.remove(sid);
    if (outcome === 'not-found') return reply.code(404).send({ error: 'not_found' });
    if (outcome === 'has-subaccounts') {
      return reply.code(409).send({
        error: 'has_subaccounts',
        message: `${sid} still has ${store.accounts.subaccountCount(sid)} subaccount(s); delete them first`,
      });
    }
    if (outcome === 'has-numbers') {
      return reply.code(409).send({
        error: 'has_numbers',
        message: `${sid} still holds ${store.accounts.numberCount(sid)} number(s); release them first`,
      });
    }
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- numbers */

  app.get('/admin/numbers', async (request) => {
    const { account_sid: accountSid } = request.query as { account_sid?: string };
    return { numbers: store.numbers.list(accountSid).map(numberView) };
  });

  app.get('/admin/numbers/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const number = store.numbers.find(sid);
    if (number === null) return reply.code(404).send({ error: 'not_found' });
    return { ...numberView(number), usage: store.numbers.usage(number.phoneNumber) };
  });

  app.post('/admin/numbers', async (request, reply) => {
    const parsed = numberBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    if (store.accounts.find(body.account_sid) === null) {
      return reply.code(400).send({
        error: 'no_such_account',
        message: `${body.account_sid} is not an account this simulator holds`,
      });
    }
    const existing = store.numbers.findByNumber(body.phone_number);
    if (existing) {
      // Names the `PN…` that is in the way rather than answering a bare 409: the next
      // thing anybody wants is to go and edit that one.
      return reply.code(409).send({
        error: 'exists',
        message: `${body.phone_number} is already held as ${existing.sid}`,
        sid: existing.sid,
      });
    }
    const number = store.numbers.create({
      phoneNumber: body.phone_number,
      accountSid: body.account_sid,
      friendlyName: body.friendly_name,
      voiceUrl: body.voice_url,
      voiceMethod: body.voice_method,
      statusCallbackUrl: body.status_callback_url,
      statusCallbackMethod: body.status_callback_method,
      smsUrl: body.sms_url,
      smsMethod: body.sms_method,
    });
    return reply.code(201).send(numberView(number));
  });

  /**
   * A partial update — which is what the Numbers panel's in-place edit sends.
   *
   * The webhook URLs are the fields that actually change day to day, and a `PATCH` that
   * mentioned only one of them must not blank the rest. A field left out keeps its value;
   * a field sent as `""` or `null` is cleared. See `PhoneNumbers.update`.
   */
  app.patch('/admin/numbers/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const parsed = numberPatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    if (body.account_sid && store.accounts.find(body.account_sid) === null) {
      return reply.code(400).send({ error: 'no_such_account' });
    }
    const number = store.numbers.update(sid, {
      accountSid: body.account_sid,
      friendlyName: body.friendly_name,
      voiceUrl: body.voice_url,
      voiceMethod: body.voice_method,
      statusCallbackUrl: body.status_callback_url,
      statusCallbackMethod: body.status_callback_method,
      smsUrl: body.sms_url,
      smsMethod: body.sms_method,
    });
    if (number === null) return reply.code(404).send({ error: 'not_found' });
    return numberView(number);
  });

  /** The history stays. `calls` and `messages` hold the numbers as text, not as a key. */
  app.delete('/admin/numbers/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    if (!store.numbers.remove(sid)) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  /* --------------------------------------------------------------- api keys */

  /* ------------------------------------------------------ messaging services */

  app.get('/admin/messaging-services', async (request) => {
    const { account_sid: accountSid } = request.query as { account_sid?: string };
    return {
      messaging_services: store.messagingServices
        .list(accountSid)
        .map((service) => messagingServiceView(service, store)),
    };
  });

  app.get('/admin/messaging-services/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const service = store.messagingServices.find(sid);
    if (!service) return reply.code(404).send({ error: 'not_found' });
    return messagingServiceView(service, store);
  });

  app.post('/admin/messaging-services', async (request, reply) => {
    const parsed = messagingServiceBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    if (store.accounts.find(body.account_sid) === null) {
      return reply.code(400).send({
        error: 'no_such_account',
        message: `${body.account_sid} is not an account this simulator holds`,
      });
    }
    if (body.sid && store.messagingServices.find(body.sid) !== null) {
      return reply.code(409).send({
        error: 'exists',
        message: `${body.sid} is already a messaging service`,
      });
    }
    // **Every named number is resolved before anything is written.** A pool stated up
    // front is one intention; half of it applied and the rest refused is a service the
    // person did not ask for, sitting there looking as though it worked.
    const members: PhoneNumber[] = [];
    for (const phoneNumber of body.phone_numbers ?? []) {
      const refusal = poolRefusal(store, body.account_sid, phoneNumber);
      if (refusal) return reply.code(refusal.code).send(refusal.body);
      const number = store.numbers.findByNumber(phoneNumber);
      if (number) members.push(number);
    }

    const service = store.db.transaction(() => {
      const created = store.messagingServices.create({
        accountSid: body.account_sid,
        sid: body.sid,
        friendlyName: body.friendly_name,
        inboundRequestUrl: body.inbound_request_url,
        inboundMethod: body.inbound_method,
        statusCallbackUrl: body.status_callback_url,
      });
      for (const number of members) store.messagingServices.addNumber(created.sid, number.sid);
      return created;
    })();
    return reply.code(201).send(messagingServiceView(service, store));
  });

  app.patch('/admin/messaging-services/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const parsed = messagingServicePatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    const updated = store.messagingServices.update(sid, {
      friendlyName: body.friendly_name,
      inboundRequestUrl: body.inbound_request_url,
      inboundMethod: body.inbound_method,
      statusCallbackUrl: body.status_callback_url,
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return messagingServiceView(updated, store);
  });

  /**
   * Delete a service, pool and all.
   *
   * No guard on a non-empty pool, unlike an account holding numbers: the pool rows are the
   * service's own and go with it, the numbers are untouched, and the messages that named
   * the `MG…` keep it as text. It is the same bargain `DELETE /admin/keys/:sid` makes.
   */
  app.delete('/admin/messaging-services/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    if (!store.messagingServices.remove(sid)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.code(204).send();
  });

  app.post('/admin/messaging-services/:sid/numbers', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const service = store.messagingServices.find(sid);
    if (!service) return reply.code(404).send({ error: 'not_found' });
    const parsed = poolBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const number = store.numbers.find(parsed.data.phone_number_sid);
    if (!number) {
      return reply.code(400).send({
        error: 'no_such_number',
        message: `${parsed.data.phone_number_sid} is not a number this simulator holds`,
      });
    }
    const refusal = poolRefusal(store, service.accountSid, number.phoneNumber, service.sid);
    if (refusal) return reply.code(refusal.code).send(refusal.body);
    store.messagingServices.addNumber(service.sid, number.sid);
    return reply.code(201).send(messagingServiceView(service, store));
  });

  app.delete('/admin/messaging-services/:sid/numbers/:numberSid', async (request, reply) => {
    const { sid, numberSid } = request.params as { sid: string; numberSid: string };
    const service = store.messagingServices.find(sid);
    if (!service) return reply.code(404).send({ error: 'not_found' });
    if (!store.messagingServices.removeNumber(service.sid, numberSid)) {
      return reply.code(404).send({ error: 'not_in_service' });
    }
    return reply.code(204).send();
  });

  app.get('/admin/keys', async (request) => {
    const { account_sid: accountSid } = request.query as { account_sid?: string };
    return { keys: store.apiKeys.list(accountSid).map((key) => keyView(key)) };
  });

  /** `?reveal=1` is the only **read** in the app that answers a key's secret. */
  app.get('/admin/keys/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const key = store.apiKeys.find(sid);
    if (key === null) return reply.code(404).send({ error: 'not_found' });
    const { reveal } = request.query as { reveal?: string };
    return keyView(key, reveal === '1' || reveal === 'true');
  });

  app.post('/admin/keys', async (request, reply) => {
    const parsed = keyBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const body = parsed.data;
    if (store.accounts.find(body.account_sid) === null) {
      return reply.code(400).send({
        error: 'no_such_account',
        message: `${body.account_sid} is not an account this simulator holds`,
      });
    }
    if (body.sid && store.apiKeys.find(body.sid)) {
      return reply.code(409).send({ error: 'exists', message: 'that key sid is already held', sid: body.sid });
    }
    const key = store.apiKeys.create({
      accountSid: body.account_sid,
      friendlyName: body.friendly_name,
      sid: body.sid,
      secret: body.secret,
    });
    // The secret is in this one answer, for the same reason a new account's token is: the
    // whole point of creating a key is to paste it somewhere.
    return reply.code(201).send(keyView(key, true));
  });

  app.patch('/admin/keys/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const parsed = keyPatch.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const key = store.apiKeys.update(sid, { friendlyName: parsed.data.friendly_name });
    if (key === null) return reply.code(404).send({ error: 'not_found' });
    return keyView(key);
  });

  /** No guard: a key holds nothing. Deleting one only takes a credential out of use. */
  app.delete('/admin/keys/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    if (store.apiKeys.remove(sid) === 'not-found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  /* ------------------------------------------------------------------- seed */

  app.post('/admin/seed', async (request, reply) => {
    const parsed = seedSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const result = applySeed(store, parsed.data);
    return reply.send(result);
  });
}

/**
 * Apply a seed, **upserting**.
 *
 * Run at boot from `SEED` and over HTTP from `/admin/seed`, and it has to be safe
 * to run twice: a seed file is checked into somebody's repository and is applied on every
 * start. Accounts are keyed by sid and numbers by the number itself, which is what a seed
 * file actually names.
 *
 * A number with no `account_sid` joins the first account in the file, or the only account
 * that exists. That is the common case — one account, several numbers — and spelling the
 * sid on every entry would mean editing the file whenever an account is re-minted.
 */
export function applySeed(store: Store, seed: Seed): { accounts: number; numbers: number; messaging_services: number } {
  // **Two passes**, because a seed file may list a child before its parent and neither
  // order is wrong. The first creates every account; the second links the children, by
  // which point every sid the file names exists.
  const accounts = seed.accounts.map((entry) =>
    entry.account_sid
      ? store.accounts.upsert({
          accountSid: entry.account_sid,
          authToken: entry.auth_token,
          friendlyName: entry.friendly_name,
          status: entry.status,
        })
      : store.accounts.create({
          authToken: entry.auth_token,
          friendlyName: entry.friendly_name,
          status: entry.status,
        }),
  );

  seed.accounts.forEach((entry, index) => {
    const sid = accounts[index]?.accountSid;
    if (!sid || !entry.parent_account_sid) return;
    const refusal = parentRefusal(store, entry.parent_account_sid);
    if (refusal) throw new Error(`the seed makes ${sid} a subaccount, but ${refusal.message}`);
    // `upsert` will not reparent an account that already exists, so the link is set here.
    store.accounts.adopt(sid, entry.parent_account_sid);
  });

  // **Top-level accounts only.** A parent seeded with one child is two rows, and counting
  // both would silently turn the "only account there is" fallback into a throw.
  const existing = store.accounts.list().filter((account) => account.parentAccountSid === null);
  const fallback = accounts[0]?.accountSid ?? (existing.length === 1 ? existing[0]?.accountSid : undefined);

  let numbers = 0;
  for (const entry of seed.numbers) {
    const accountSid = entry.account_sid ?? fallback;
    if (!accountSid) {
      throw new Error(
        `the seed names ${entry.phone_number} but no account_sid, and there is not exactly one account to fall back to`,
      );
    }
    store.numbers.upsert({
      phoneNumber: entry.phone_number,
      accountSid,
      friendlyName: entry.friendly_name,
      voiceUrl: entry.voice_url,
      voiceMethod: entry.voice_method,
      statusCallbackUrl: entry.status_callback_url,
      statusCallbackMethod: entry.status_callback_method,
      smsUrl: entry.sms_url,
      smsMethod: entry.sms_method,
    });
    numbers += 1;
  }

  // **A third pass, after the numbers**, because a pool names numbers the same file may
  // have just created. `upsert` keys on the pinned sid, or on the name — never on nothing,
  // since a seed is re-applied on every start and a service re-minted each boot would
  // orphan the `MG…` sitting in the application's own configuration.
  let messagingServices = 0;
  for (const entry of seed.messaging_services) {
    const accountSid = entry.account_sid ?? fallback;
    if (!accountSid) {
      throw new Error(
        `the seed names the messaging service ${entry.friendly_name ?? '(unnamed)'} but no account_sid, and there is not exactly one account to fall back to`,
      );
    }
    const service = store.messagingServices.upsert({
      accountSid,
      sid: entry.sid,
      friendlyName: entry.friendly_name,
      inboundRequestUrl: entry.inbound_request_url,
      inboundMethod: entry.inbound_method,
      statusCallbackUrl: entry.status_callback_url,
    });
    // **The pool is declarative**: the file states what it is, so re-applying converges
    // rather than piling members up. Stated as nothing at all, it is left alone — an
    // absent key is not the same as an empty list.
    if (entry.phone_numbers) {
      for (const number of store.messagingServices.numbers(service.sid)) {
        if (!entry.phone_numbers.includes(number.phoneNumber)) {
          store.messagingServices.removeNumber(service.sid, number.sid);
        }
      }
      for (const phoneNumber of entry.phone_numbers) {
        const refusal = poolRefusal(store, accountSid, phoneNumber, service.sid);
        if (refusal) {
          throw new Error(
            `the seed puts ${phoneNumber} in ${service.sid}, but ${refusal.body.message}`,
          );
        }
        const held = store.numbers.findByNumber(phoneNumber);
        if (held) store.messagingServices.addNumber(service.sid, held.sid);
      }
    }
    messagingServices += 1;
  }

  return { accounts: accounts.length, numbers, messaging_services: messagingServices };
}
