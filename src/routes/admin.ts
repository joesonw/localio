import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Account, AccountStatus, ApiKey, PhoneNumber, Store } from '../db/index.js';

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
  sms_status_callback_url: urlOrNull,
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

/** Accounts and numbers together — the shape of the seed file and of `POST /admin/seed`. */
export const seedSchema = z.object({
  accounts: z.array(accountBody.extend({ account_sid: z.string().optional() })).default([]),
  numbers: z.array(numberBody.partial({ account_sid: true })).default([]),
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
    sms_status_callback_url: number.smsStatusCallbackUrl,
    created_at: number.createdAt,
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
      smsStatusCallbackUrl: body.sms_status_callback_url,
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
      smsStatusCallbackUrl: body.sms_status_callback_url,
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
export function applySeed(store: Store, seed: Seed): { accounts: number; numbers: number } {
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
      smsStatusCallbackUrl: entry.sms_status_callback_url,
    });
    numbers += 1;
  }
  return { accounts: accounts.length, numbers };
}
