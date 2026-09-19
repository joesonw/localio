import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { CallFeed } from '../call-feed.js';
import { parseEventRequest, postCallStatus } from '../call-status.js';
import type { Config } from '../config.js';
import { preview } from '../log.js';
import type { Account, AccountStatus, ApiKey, Call, Message, PhoneNumber, Recording, Store } from '../db/index.js';
import type { SmsService } from '../sms.js';
import type { WebhookPoster } from '../webhook.js';

/**
 * The Twilio REST API, faked.
 *
 * A Twilio SDK client points its whole `api` domain at one base URL, so redirecting it
 * here redirects *everything* — calls, messages, provisioning, recordings. A route left
 * unfaked would fall through to the static handler's 404, which reads as a Twilio outage
 * rather than as a gap in a development tool. That is what the **`501` catch-all** at the
 * bottom is for, and why it is registered last and names the path it will not fake.
 *
 * Five things hold this file together:
 *
 * - **Snake_case, always.** The SDK deserializes into camelCase itself, so answering
 *   camelCase type-checks nowhere and quietly produces a resource whose every optional
 *   field is `undefined`.
 * - **RFC 2822 timestamps**, because the SDK parses them with a date reader that turns an
 *   ISO 8601 string into an `Invalid Date` — silently.
 * - **`duration` is a string** of whole seconds, and empty while a call is up.
 * - **Anything no simulator can know is `null`** — `price`, `answered_by`, `caller_name`,
 *   `forwarded_from` — rather than a plausible value. A mock that invents a price is a
 *   mock somebody eventually believes.
 * - **A sid nothing knows is a 404 in Twilio's own error shape** (`20404`). A bare Fastify
 *   404 is reported by an SDK as a transport failure rather than as a resource that does
 *   not exist.
 *
 * Unlike the app this was extracted from, **HTTP Basic is verified**. That app could not:
 * Twilio guards these with an API key and it had never held one. `localio` mints the
 * accounts itself, so there is a token to check, and checking it means an application
 * with the wrong credentials fails here the way it would fail against Twilio. **Either
 * credential is accepted** — an account sid with its auth token, or an `SK…` API key of
 * that account with its secret — because a client configured with a key sends the key,
 * and refusing it here would read as the key being wrong.
 */

const API = '/2010-04-01';

/** The statuses `POST Accounts/:sid.json` will accept. `active` is the only one that opens. */
const STATUSES: AccountStatus[] = ['active', 'suspended', 'closed'];

interface Deps {
  store: Store;
  sms: SmsService;
  config: Config;
  logger: Logger;
  /** For the call-progress callbacks this file posts itself — `initiated`, and nothing else. */
  poster: WebhookPoster;
  /** Calls currently up, so `getCall` can report a duration that is still moving. */
  liveCallSids: () => Set<string>;
  /** Advisory push, so the Phone panel sees a placed call without waiting for its poll. */
  feed: CallFeed;
  /** End a live call from outside its socket. False when no session holds that sid. */
  endCall: (sid: string) => boolean;
}

/** Twilio's error envelope. Every refusal in this file wears it. */
function twilioError(reply: FastifyReply, status: number, code: number, message: string): void {
  void reply.code(status).send({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status });
}

/**
 * Twilio's list envelope, which the SDK's auto-paginator actually walks.
 *
 * **`next_page_uri` is the load-bearing field.** `client.messages.list()` follows it until
 * it is null; without one it stops after a single page and reports a truncated set as the
 * whole of it, which is a wrong answer that looks like a right one. The five list routes
 * here used to emit `{page, page_size, uri}` and nothing else, with `page_size` set to the
 * number of rows *returned* rather than the page size asked for — so a short last page
 * read as a smaller request.
 *
 * `start` and `end` are inclusive 0-based indices into the whole result set, as at Twilio.
 */
function pageEnvelope<T>(
  key: string,
  path: string,
  rows: T[],
  page: number,
  pageSize: number,
): Record<string, unknown> {
  const start = page * pageSize;
  const slice = rows.slice(start, start + pageSize);
  const hasMore = start + slice.length < rows.length;
  const at = (n: number): string => `${path}?PageSize=${pageSize}&Page=${n}`;
  return {
    [key]: slice,
    page,
    page_size: pageSize,
    start,
    // Inclusive, so an empty page reports the index it would have started at.
    end: start + Math.max(slice.length - 1, 0),
    uri: at(page),
    first_page_uri: at(0),
    previous_page_uri: page > 0 ? at(page - 1) : null,
    next_page_uri: hasMore ? at(page + 1) : null,
  };
}

/** `PageSize` and `Page` off the query string, clamped to something a page can hold. */
function paging(query: { PageSize?: string; Page?: string }): { page: number; pageSize: number } {
  const size = Number.parseInt(query.PageSize ?? '50', 10);
  const page = Number.parseInt(query.Page ?? '0', 10);
  return {
    pageSize: Number.isFinite(size) && size > 0 ? Math.min(size, 1000) : 50,
    page: Number.isFinite(page) && page > 0 ? page : 0,
  };
}

/** RFC 2822, which is what the SDK's date reader expects. `toUTCString` is exactly it. */
function rfc2822(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toUTCString();
}

export function registerTwilioApi(app: FastifyInstance, deps: Deps): void {
  const { store, sms, config, logger, feed, poster, endCall } = deps;

  /* ------------------------------------------------------------- the access log */

  /**
   * What an application actually asked this process for.
   *
   * Fastify's own per-request logging is off (see `server.ts`), so these two hooks are the
   * whole of it — and they are **scoped by hand**: `registerTwilioApi` is called on the
   * same encapsulated instance as `/admin` and `/api`, so a hook added here fires for
   * those too. Hence the prefix test on every one. Drop it and the Phone panel's polling
   * floods the terminal, which is precisely what `disableRequestLogging` was turned on to
   * stop.
   *
   * No headers are logged, at any level. `authorization` on these routes is an account's
   * live auth token, and a log line is the easiest thing in the world to paste.
   */
  function ours(request: FastifyRequest): boolean {
    return request.url.startsWith(API);
  }

  app.addHook('onResponse', async (request, reply) => {
    if (!ours(request)) return;
    const line = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      // Fastify measures this itself, from the moment the request arrived.
      ms: Math.round(reply.elapsedTime),
    };
    // A 5xx here is the `501` catch-all below, and it is the single most useful line this
    // log produces: it names a path localio does not fake, which is why the SDK calling it
    // is behaving strangely. It should not read like a success. A 4xx stays at `info` —
    // a rejected credential or an unknown sid is an outcome, not a fault of this process.
    if (reply.statusCode >= 500) logger.warn(line, 'twilio api');
    else logger.info(line, 'twilio api');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // Guarded rather than levelled: building the preview means stringifying a resource on
    // every request, and at `info` nothing would read it.
    if (!ours(request) || !logger.isLevelEnabled('debug')) return payload;
    const line: Record<string, unknown> = {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      form: request.body,
    };
    // The recording media route sends a `createReadStream`. Consuming it to log it would
    // serve the caller an empty body, so the audio is described rather than shown.
    if (typeof payload === 'string') line.payload = preview(payload);
    else {
      line.payload = `[${reply.getHeader('content-type') ?? 'stream'}]`;
      line.bytes = reply.getHeader('content-length');
    }
    logger.debug(line, 'twilio api body');
    return payload;
  });

  /**
   * HTTP Basic against the `accounts` table.
   *
   * The username is the account sid and the password is the auth token, or the username is
   * an `SK…` key of that account and the password its secret — the two things a Twilio
   * client sends, depending on how it was built. Compared in constant time — not
   * because this is a security boundary (it is a development tool on loopback) but
   * because a timing-variable compare is the kind of thing that gets copied out of here
   * into something that is.
   */
  function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
    accountSid: string,
    options: { requireActive?: boolean } = {},
  ): Account | null {
    const account = store.accounts.find(accountSid);
    if (account === null) {
      twilioError(reply, 404, 20404, `Account ${accountSid} was not found`);
      return null;
    }
    // The credential may be the account's own or its **parent's** — Twilio lets a parent
    // operate on its subaccounts, and a client built as
    // `twilio(parentSid, parentToken, { accountSid: childSid })` sends exactly that.
    const credential = resolveCredential(request, reply, [
      account.accountSid,
      ...(account.parentAccountSid === null ? [] : [account.parentAccountSid]),
    ]);
    if (credential === null) return null;
    // The credential's account is always checked: a suspended parent opens nothing, and a
    // suspended account cannot present its own credentials to un-suspend itself.
    if (!active(reply, credential)) return null;
    // The account in the path is checked for every *resource* route, and deliberately not
    // for the two `Accounts/:sid.json` ones. Gating those on it would make `suspend` a
    // one-way door: the parent could stop a child and then have no way to start it again,
    // because the route that revives it is behind the very check being failed.
    if (options.requireActive !== false && !active(reply, account)) return null;
    // **The account in the path is what comes back, always** — never the credential's.
    // A call placed with a parent's credentials at a child's path is the *child's* call,
    // and `call.ts` signs its webhooks with the token of the account that owns the row.
    // Returning the parent here would sign a child's webhooks with the parent's token,
    // which the Twilio SDK's validator rejects with nothing naming why.
    return account;
  }

  /**
   * Basic auth with no sid in the path — what `/Accounts.json` has to use.
   *
   * Whatever the username resolves to *is* the account, so there is no path sid to check
   * it against and no parent rule to apply.
   */
  function authenticateSelf(request: FastifyRequest, reply: FastifyReply): Account | null {
    const credential = resolveCredential(request, reply, null);
    if (credential === null) return null;
    if (!active(reply, credential)) return null;
    return credential;
  }

  /**
   * The Basic header, resolved to the account that owns the credential.
   *
   * `allowed` is the set of account sids whose credentials are acceptable, or `null` for
   * "whoever this is". An `SK…` username is an API key, which is what a client built as
   * `twilio(keySid, keySecret, { accountSid })` sends; either credential resolves to the
   * **account**, because a key authenticates a request and never signs a webhook.
   */
  function resolveCredential(
    request: FastifyRequest,
    reply: FastifyReply,
    allowed: string[] | null,
  ): Account | null {
    const header = request.headers.authorization ?? '';
    if (!header.toLowerCase().startsWith('basic ')) {
      twilioError(reply, 401, 20003, 'Authentication Error - No credentials provided');
      return null;
    }
    // Split on the *first* colon only: a password containing one would otherwise be
    // truncated at it, and the credential silently becomes a different credential. No
    // auth token or key secret contains one, which is why this was never a live bug —
    // but a credential is the one thing worth parsing exactly.
    const decoded = Buffer.from(header.slice(header.indexOf(' ') + 1), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon === -1 ? decoded : decoded.slice(0, colon);
    const password = colon === -1 ? '' : decoded.slice(colon + 1);
    const refuse = (): null => {
      twilioError(reply, 401, 20003, 'Authentication Error - invalid username');
      return null;
    };
    // A credential that does not open the account in the path is a 401, not a 404: the
    // account exists, the caller simply cannot have it.
    const permitted = (sid: string): boolean => allowed === null || allowed.includes(sid);
    if (user.startsWith('SK')) {
      const key = store.apiKeys.find(user);
      if (key === null || !permitted(key.accountSid) || !constantEquals(password, key.secret)) {
        return refuse();
      }
      // `?? refuse()` rather than the bare lookup: a key whose account is gone cannot
      // happen (the foreign key sees to that), but returning `null` without having sent a
      // reply would leave the route answering nothing at all, which is a hung request
      // rather than a refused one.
      return store.accounts.find(key.accountSid) ?? refuse();
    }
    if (!permitted(user)) return refuse();
    // Resolved rather than compared against the path account, so a parent's username is
    // checked against the *parent's* token.
    const owner = store.accounts.find(user);
    if (owner === null || !constantEquals(password, owner.authToken)) return refuse();
    return owner;
  }

  /**
   * A non-`active` account opens nothing — no calls, no messages, no numbers.
   *
   * It is revived from `/admin`, or over REST by its **parent**, which reaches it because
   * `Accounts/:sid.json` passes `requireActive: false`. Its own credentials never do.
   */
  function active(reply: FastifyReply, account: Account): boolean {
    if (account.status === 'active') return true;
    twilioError(reply, 401, 20005, `Account ${account.accountSid} is not active`);
    return false;
  }

  /* ------------------------------------------------------------------- calls */

  /**
   * `placeCall`. **Registers rather than acknowledges**, which is the whole point.
   *
   * The `CA…` comes out of the store, and the row stays behind as a call waiting to be
   * answered on the Dial panel. `queued` is the honest status: it is what Twilio can say
   * synchronously, and here it is true in the same way — nothing has rung yet.
   *
   * **The `Url` is kept, not merely noted.** It is what the call will be answered at, and
   * an application puts its own routing on that URL's query string. Answering at the
   * number's standing `voice_url` instead would send a call placed for one purpose
   * wherever the number happens to point, and nothing would say so.
   */
  app.post(`${API}/Accounts/:accountSid/Calls.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const body = request.body as Record<string, string>;
    if (!body?.From || !body?.To) {
      return twilioError(reply, 400, 21201, "No 'To' or 'From' number specified");
    }
    const call = store.calls.create({
      accountSid: account.accountSid,
      from: body.From,
      to: body.To,
      direction: 'outbound-api',
      status: 'queued',
      answerUrl: body.Url ?? null,
      // Twilio takes inline TwiML instead of a `Url`. Kept apart rather than folded into
      // one column, because "answer at this URL" and "answer with this document" are
      // different instructions and a reader of the row has to be able to tell which.
      answerTwiml: body.Twiml ?? null,
      answerMethod: body.Method ?? 'POST',
      statusCallbackUrl: body.StatusCallback ?? null,
      statusCallbackMethod: body.StatusCallbackMethod ?? 'POST',
      statusCallbackEvents: parseEventRequest(
        (request.body as Record<string, unknown> | undefined)?.StatusCallbackEvent,
      ),
    });
    store.calls.log(call.sid, 'webhook', { kind: 'placed', url: body.Url ?? null });
    // `initiated` is the first of the four, and it is posted from here rather than from
    // the session because no session exists yet — the call is registered and waiting.
    // Most placements never ask for it: Twilio's default set is `completed` alone.
    await postCallStatus(
      { store, poster, logger },
      { call, event: 'initiated', status: 'queued', authToken: account.authToken },
    );
    // The row is already there, so the strip can draw it now rather than on the page's
    // next two-second poll. Advisory: the poll is still what heals a page that missed it.
    feed.publish({ kind: 'ringing', call, claimedBy: null });
    return reply.code(201).send(callResource(call, deps));
  });

  app.get(`${API}/Accounts/:accountSid/Calls.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const query = request.query as { PageSize?: string; Page?: string; Status?: string };
    const { page, pageSize } = paging(query);
    // Filtered *then* paged. The limit used to be pushed into the store query and applied
    // before the account filter, so a page could come back short — or empty — while more
    // of this account's rows matched further down.
    const calls = store.calls
      .list({})
      .filter((call) => call.accountSid === account.accountSid)
      .filter((call) => !query.Status || call.status === query.Status);
    return reply.send(
      pageEnvelope(
        'calls',
        `${API}/Accounts/${account.accountSid}/Calls.json`,
        calls.map((call) => callResource(call, deps)),
        page,
        pageSize,
      ),
    );
  });

  /**
   * `getCall`. Answers out of the one row, whether the call is queued, up or long over.
   *
   * The app this was extracted from needed three sources for this — a live object, an
   * in-memory registry and an analytics store — because it persisted nothing. One table
   * replaces all three, and the live set is consulted only for the one thing a row cannot
   * know: that the duration is still moving.
   */
  app.get(`${API}/Accounts/:accountSid/Calls/:callSid.json`, async (request, reply) => {
    const { accountSid, callSid } = request.params as { accountSid: string; callSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const call = owned(reply, account, store.calls.find(callSid), 'Call', callSid);
    if (!call) return;
    return reply.send(callResource(call, deps));
  });

  /**
   * Update a call in flight — the SDK's `.update()`.
   *
   * **`Status` is honoured.** `completed` ends a live call and `canceled` drops one that
   * is still queued, which is how an application hangs up on its own call and the single
   * most-used operation on this route. Ending it goes through the session's one teardown,
   * so it posts the status callback and writes the row exactly as any other hang-up does.
   *
   * **`Url` and `Twiml` are still only logged**, and that is a real gap rather than a
   * decision: redirecting a live call means abandoning whatever verb is mid-flight, and
   * the executor has no cancellation to hang that on. It is logged and answered rather
   * than refused so the SDK call does not fail, and it is named in the README's list of
   * what this is not.
   *
   * The answer is the row as it now stands, not a fixed `in-progress` — reporting a call
   * as in-progress immediately after being told to end it is the one answer guaranteed
   * to be wrong.
   */
  app.post(`${API}/Accounts/:accountSid/Calls/:callSid.json`, async (request, reply) => {
    const { accountSid, callSid } = request.params as { accountSid: string; callSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const call = owned(reply, account, store.calls.find(callSid), 'Call', callSid);
    if (!call) return;
    const body = (request.body ?? {}) as Record<string, string>;
    store.calls.log(call.sid, 'webhook', { kind: 'update', body: request.body });

    if (body.Status === 'completed' || body.Status === 'canceled') {
      // A live call ends through the session, which owns the one teardown and posts the
      // callback from it. A still-queued one has no session, so the conditional cancel
      // is the whole of it — and the callback has to be posted here, or a call the
      // application itself gave up on is the one call it never hears the end of.
      const live = body.Status === 'completed' && endCall(call.sid);
      if (!live && store.calls.cancel(call.sid)) {
        await postCallStatus(
          { store, poster, logger },
          {
            call: store.calls.find(call.sid) ?? call,
            event: 'completed',
            status: 'canceled',
            authToken: account.authToken,
          },
        );
      }
    } else if (body.Url !== undefined || body.Twiml !== undefined) {
      logger.warn(
        { callSid: call.sid },
        'a call was asked to be redirected, which localio logs but does not do',
      );
    }

    return reply.send(callResource(store.calls.find(call.sid) ?? call, deps));
  });

  /* ---------------------------------------------------------------- messages */

  /**
   * `sendSms`. **Delivers rather than acknowledges**, which is the other half of the
   * round trip: a message to a number this simulator holds reaches that number's
   * `sms_url` as a signed inbound webhook, and its reply comes back into the thread.
   *
   * The `SM…` is minted by the store, not by this route — the sid answered here is what
   * the application stores as its own message id, so it and the sid in the thread have to
   * be one value.
   *
   * `status` is `queued` in the answer whatever happened afterwards, because that is what
   * Twilio can say synchronously. Delivery is reported on the row and, if this request
   * named a `StatusCallback`, over that — **per message, which is Twilio's shape**. There
   * is no SMS status callback on a number: `IncomingPhoneNumber` has `sms_url` for inbound
   * messages and `status_callback` for voice, and nothing for delivery status.
   */
  app.post(`${API}/Accounts/:accountSid/Messages.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const body = request.body as Record<string, string>;
    if (!body?.To) return twilioError(reply, 400, 21604, "A 'To' phone number is required");
    if (body.Body === undefined) {
      return twilioError(reply, 400, 21602, 'Message body is required');
    }
    const from = body.From ?? body.MessagingServiceSid ?? '';
    if (!from) return twilioError(reply, 400, 21603, "A 'From' phone number is required");

    // Delivery is awaited so the row is settled before the answer, but the *status* in
    // that answer is `queued` regardless — see the doc above. What a real Twilio can say
    // synchronously is that it accepted the message, and nothing more.
    const result = await sms.send({
      from,
      to: body.To,
      body: body.Body,
      accountSid: account.accountSid,
      direction: 'outbound-api',
      statusCallbackUrl: body.StatusCallback ?? null,
      messagingServiceSid: body.MessagingServiceSid ?? null,
    });
    return reply.code(201).send(messageResource({ ...result.message, status: 'queued' }));
  });

  app.get(`${API}/Accounts/:accountSid/Messages.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const query = request.query as { To?: string; From?: string; PageSize?: string; Page?: string };
    const { page, pageSize } = paging(query);
    const messages = store.messages
      .list({ to: query.To, from: query.From })
      .filter((message) => message.accountSid === account.accountSid);
    return reply.send(
      pageEnvelope(
        'messages',
        `${API}/Accounts/${account.accountSid}/Messages.json`,
        messages.map((message) => messageResource(message)),
        page,
        pageSize,
      ),
    );
  });

  app.get(`${API}/Accounts/:accountSid/Messages/:messageSid.json`, async (request, reply) => {
    const { accountSid, messageSid } = request.params as {
      accountSid: string;
      messageSid: string;
    };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const message = owned(reply, account, store.messages.find(messageSid), 'Message', messageSid);
    if (!message) return;
    return reply.send(messageResource(message));
  });

  /**
   * A message's media, which for a message localio carried is always none.
   *
   * Registered because `messageResource` advertises this path in `subresource_uris`, and
   * an unregistered subresource falls through to the `501` catch-all — so the SDK's
   * `message.media.list()` failed on a link this very file handed it. An empty list is
   * the true answer: there is no MMS here, and `num_media` has always said `0`.
   */
  app.get(`${API}/Accounts/:accountSid/Messages/:messageSid/Media.json`, async (request, reply) => {
    const { accountSid, messageSid } = request.params as {
      accountSid: string;
      messageSid: string;
    };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const message = owned(reply, account, store.messages.find(messageSid), 'Message', messageSid);
    if (!message) return;
    const { page, pageSize } = paging(request.query as { PageSize?: string; Page?: string });
    return reply.send(
      pageEnvelope(
        'media_list',
        `${API}/Accounts/${account.accountSid}/Messages/${messageSid}/Media.json`,
        [],
        page,
        pageSize,
      ),
    );
  });

  /* ----------------------------------------------------------------- numbers */

  /**
   * Provisioning, and **here it is real**.
   *
   * The app this was extracted from answered a plausible `PN…` and created nothing, which
   * left an application holding a row for a number no account held — its own
   * documentation called that the expensive edge. There is no inventory to model here
   * because `localio` *is* the inventory: a provisioned number is a `phone_numbers` row,
   * and it answers calls from that moment.
   */
  app.post(`${API}/Accounts/:accountSid/IncomingPhoneNumbers.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const body = request.body as Record<string, string>;
    const settings = {
      accountSid: account.accountSid,
      friendlyName: body?.FriendlyName,
      voiceUrl: body?.VoiceUrl ?? null,
      voiceMethod: body?.VoiceMethod ?? 'POST',
      statusCallbackUrl: body?.StatusCallback ?? null,
      statusCallbackMethod: body?.StatusCallbackMethod ?? 'POST',
      smsUrl: body?.SmsUrl ?? null,
      smsMethod: body?.SmsMethod ?? 'POST',
    };
    const phoneNumber = body?.PhoneNumber?.trim() ?? '';
    const areaCode = body?.AreaCode?.trim() ?? '';

    /**
     * **`AreaCode` names an NPA, not a number**, and Twilio picks the line itself.
     *
     * This field used to be read as a second spelling of `PhoneNumber`, which meant a
     * real `areaCode: '415'` came back `21421 PhoneNumber is not a valid E.164 number` —
     * an error naming a parameter the caller never sent, about a value that was fine.
     * `PhoneNumber` still wins when both are given, as it does at Twilio.
     */
    if (!phoneNumber && areaCode) {
      if (!/^[2-9]\d{2}$/.test(areaCode)) {
        return twilioError(reply, 400, 21421, `${areaCode} is not a valid area code`);
      }
      const allocated = store.numbers.createInAreaCode(areaCode, settings);
      if (allocated === null) {
        // The area code was fine and the inventory was not, which is a different thing
        // from a bad request and has its own Twilio code.
        return twilioError(
          reply,
          400,
          21452,
          `No phone numbers available in area code ${areaCode}`,
        );
      }
      return reply.code(201).send(numberResource(allocated));
    }

    if (!phoneNumber.startsWith('+')) {
      return twilioError(reply, 400, 21421, 'PhoneNumber is not a valid E.164 number');
    }
    if (store.numbers.findByNumber(phoneNumber) !== null) {
      return twilioError(reply, 400, 21422, `${phoneNumber} is already held`);
    }
    const number = store.numbers.create({
      ...settings,
      phoneNumber,
      friendlyName: settings.friendlyName ?? phoneNumber,
    });
    return reply.code(201).send(numberResource(number));
  });

  app.get(`${API}/Accounts/:accountSid/IncomingPhoneNumbers.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const query = request.query as { PhoneNumber?: string; PageSize?: string; Page?: string };
    const { page, pageSize } = paging(query);
    const numbers = store.numbers
      .list(account.accountSid)
      .filter((number) => !query.PhoneNumber || number.phoneNumber === query.PhoneNumber);
    return reply.send(
      pageEnvelope(
        'incoming_phone_numbers',
        `${API}/Accounts/${account.accountSid}/IncomingPhoneNumbers.json`,
        numbers.map(numberResource),
        page,
        pageSize,
      ),
    );
  });

  app.get(`${API}/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json`, async (request, reply) => {
    const { accountSid, sid } = request.params as { accountSid: string; sid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const number = owned(reply, account, store.numbers.find(sid), 'IncomingPhoneNumber', sid);
    if (!number) return;
    return reply.send(numberResource(number));
  });

  /** The SDK's `.update()` is a POST, which is the one thing about this route worth knowing. */
  app.post(`${API}/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json`, async (request, reply) => {
    const { accountSid, sid } = request.params as { accountSid: string; sid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    if (!owned(reply, account, store.numbers.find(sid), 'IncomingPhoneNumber', sid)) return;
    const body = (request.body ?? {}) as Record<string, string>;
    const updated = store.numbers.update(sid, {
      friendlyName: body.FriendlyName,
      voiceUrl: body.VoiceUrl,
      voiceMethod: body.VoiceMethod,
      statusCallbackUrl: body.StatusCallback,
      statusCallbackMethod: body.StatusCallbackMethod,
      smsUrl: body.SmsUrl,
      smsMethod: body.SmsMethod,
    });
    if (updated === null) {
      return twilioError(reply, 404, 20404, `IncomingPhoneNumber ${sid} was not found`);
    }
    return reply.send(numberResource(updated));
  });

  app.delete(`${API}/Accounts/:accountSid/IncomingPhoneNumbers/:sid.json`, async (request, reply) => {
    const { accountSid, sid } = request.params as { accountSid: string; sid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    if (!owned(reply, account, store.numbers.find(sid), 'IncomingPhoneNumber', sid)) return;
    if (!store.numbers.remove(sid)) {
      return twilioError(reply, 404, 20404, `IncomingPhoneNumber ${sid} was not found`);
    }
    return reply.code(204).send();
  });

  /* -------------------------------------------------------------- recordings */

  app.get(`${API}/Accounts/:accountSid/Recordings/:recordingSid.json`, async (request, reply) => {
    const { accountSid, recordingSid } = request.params as {
      accountSid: string;
      recordingSid: string;
    };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const recording = owned(
      reply,
      account,
      store.recordings.find(recordingSid),
      'Recording',
      recordingSid,
    );
    if (!recording) return;
    return reply.send(recordingResource(recording, config));
  });

  app.get(
    `${API}/Accounts/:accountSid/Calls/:callSid/Recordings.json`,
    async (request, reply) => {
      const { accountSid, callSid } = request.params as { accountSid: string; callSid: string };
      const account = authenticate(request, reply, accountSid);
      if (!account) return;
      // The recordings are the call's, so the call is what must be this account's.
      if (!owned(reply, account, store.calls.find(callSid), 'Call', callSid)) return;
      const { page, pageSize } = paging(request.query as { PageSize?: string; Page?: string });
      const recordings = store.recordings.list({ callSid });
      return reply.send(
        pageEnvelope(
          'recordings',
          `${API}/Accounts/${account.accountSid}/Calls/${callSid}/Recordings.json`,
          recordings.map((recording) => recordingResource(recording, config)),
          page,
          pageSize,
        ),
      );
    },
  );

  /**
   * The audio itself.
   *
   * **No authentication**, unlike every other route here, and that is deliberate rather
   * than an oversight: Twilio's own recording media URL is fetched without credentials by
   * a great deal of software, and requiring Basic here would make a `RecordingUrl` this
   * app handed out unusable in exactly the places one gets pasted. It is a development
   * tool on loopback; see the README.
   *
   * **`.mp3` answers 501.** There is no encoder here, and serving a WAV under an `.mp3`
   * name would make every client's decoder the thing that complains.
   */
  app.get(
    `${API}/Accounts/:accountSid/Recordings/:recordingSid`,
    async (request, reply) => {
      const { recordingSid } = request.params as { recordingSid: string };
      const name = recordingSid.replace(/\.wav$/i, '');
      if (/\.mp3$/i.test(recordingSid)) {
        return twilioError(reply, 501, 20501, 'localio records wav only; fetch this recording without .mp3');
      }
      const recording = store.recordings.find(name);
      if (recording === null || !existsSync(recording.path)) {
        return twilioError(reply, 404, 20404, `Recording ${name} was not found`);
      }
      return reply
        .header('content-type', 'audio/wav')
        .header('content-length', String(statSync(recording.path).size))
        .send(createReadStream(recording.path));
    },
  );

  /* --------------------------------------------------------------- api keys */

  /**
   * `Keys`. The other credential pair Twilio accepts, and one an application under test
   * may well mint for itself at boot — which is why these are faked rather than left to
   * the `20501` below.
   *
   * **The `secret` is in the create answer and nowhere else.** That is Twilio's own
   * behaviour (its `NewKey` resource carries one; `Key` does not), and answering it on
   * every read would teach a habit that breaks against the real thing. `/admin/keys/:sid?reveal=1`
   * is where a secret can be fetched again, because that is a page on loopback rather
   * than the API surface an application talks to.
   *
   * **The sid is minted here, never accepted.** Twilio does not let a caller choose one,
   * and a second mint site is the thing `provider-id.ts` exists to prevent.
   */
  app.post(`${API}/Accounts/:accountSid/Keys.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const body = (request.body ?? {}) as { FriendlyName?: string };
    const key = store.apiKeys.create({
      accountSid: account.accountSid,
      friendlyName: body.FriendlyName,
    });
    // At `debug` the access log above previews this body, secret and all. That is the same
    // bargain `/admin` makes with auth tokens, and the reason both the log level and the
    // listen address are what they are.
    return reply.code(201).send(keyResource(key, key.secret));
  });

  app.get(`${API}/Accounts/:accountSid/Keys.json`, async (request, reply) => {
    const { accountSid } = request.params as { accountSid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const { page, pageSize } = paging(request.query as { PageSize?: string; Page?: string });
    const keys = store.apiKeys.list(account.accountSid);
    return reply.send(
      pageEnvelope(
        'keys',
        `${API}/Accounts/${account.accountSid}/Keys.json`,
        keys.map((key) => keyResource(key)),
        page,
        pageSize,
      ),
    );
  });

  app.get(`${API}/Accounts/:accountSid/Keys/:keySid.json`, async (request, reply) => {
    const { accountSid, keySid } = request.params as { accountSid: string; keySid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    const key = ownKey(reply, account, keySid);
    if (!key) return;
    return reply.send(keyResource(key));
  });

  /** A `POST`, not a `PATCH`, because that is what the SDK sends. The name is all it changes. */
  app.post(`${API}/Accounts/:accountSid/Keys/:keySid.json`, async (request, reply) => {
    const { accountSid, keySid } = request.params as { accountSid: string; keySid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    if (!ownKey(reply, account, keySid)) return;
    const body = (request.body ?? {}) as { FriendlyName?: string };
    const key = store.apiKeys.update(keySid, { friendlyName: body.FriendlyName });
    if (key === null) return twilioError(reply, 404, 20404, `Key ${keySid} was not found`);
    return reply.send(keyResource(key));
  });

  app.delete(`${API}/Accounts/:accountSid/Keys/:keySid.json`, async (request, reply) => {
    const { accountSid, keySid } = request.params as { accountSid: string; keySid: string };
    const account = authenticate(request, reply, accountSid);
    if (!account) return;
    if (!ownKey(reply, account, keySid)) return;
    store.apiKeys.remove(keySid);
    return reply.code(204).send();
  });

  /**
   * A row of *this* account, or a `20404`.
   *
   * **A resource held by another account is answered as not found rather than as
   * forbidden**, which is Twilio's answer and also the only one that does not leak: a
   * `403` would confirm the sid exists, and a sid is the thing an application knows.
   * Across an account boundary it does not exist.
   *
   * Applied to every `:sid` route, not just keys. It used to be keys only, so any
   * authenticated account could read any other account's calls, recordings and message
   * bodies by naming the sid — every lookup found the row globally and returned it.
   *
   * A parent reaching into a subaccount goes through the child's path, and
   * `authenticate()` returns the account the *URL* names, so the comparison here is
   * already against the owning account rather than the credential's.
   */
  function owned<T extends { accountSid: string }>(
    reply: FastifyReply,
    account: Account,
    row: T | null,
    label: string,
    sid: string,
  ): T | null {
    if (row === null || row.accountSid !== account.accountSid) {
      twilioError(reply, 404, 20404, `${label} ${sid} was not found`);
      return null;
    }
    return row;
  }

  const ownKey = (reply: FastifyReply, account: Account, keySid: string): ApiKey | null =>
    owned(reply, account, store.apiKeys.find(keySid), 'Key', keySid);

  /* --------------------------------------------------------------- accounts */

  /**
   * Subaccounts, which is how an application segments its own customers at Twilio.
   *
   * A subaccount is a **full account**: its own `AC…`, its own auth token, its own numbers
   * and keys, its own signed webhooks. The parent's credentials open it as well as its
   * own — see `authenticate` — but nothing rolls up: a parent's `Calls.json` lists the
   * parent's calls, exactly as at Twilio.
   *
   * **One level, strictly.** A subaccount cannot hold subaccounts. Twilio publishes no
   * error code for that refusal, so the `20001` below is a judgement call rather than a
   * copied one, and the message says the rule outright — the same bargain the `501`
   * catch-all makes.
   */
  app.post(`${API}/Accounts.json`, async (request, reply) => {
    const parent = authenticateSelf(request, reply);
    if (!parent) return;
    if (parent.parentAccountSid !== null) {
      return twilioError(
        reply,
        400,
        20001,
        `${parent.accountSid} is itself a subaccount, and a subaccount cannot hold subaccounts`,
      );
    }
    const body = (request.body ?? {}) as { FriendlyName?: string };
    const account = store.accounts.create({
      friendlyName: body.FriendlyName,
      parentAccountSid: parent.accountSid,
    });
    // The token is in this answer because it is the whole point of creating a subaccount:
    // Twilio's own `Account` carries it, and there is nowhere else over REST to get it.
    return reply.code(201).send(accountResource(account));
  });

  /** The authenticated account **and** its children — which is what Twilio's list returns. */
  app.get(`${API}/Accounts.json`, async (request, reply) => {
    const self = authenticateSelf(request, reply);
    if (!self) return;
    const query = request.query as {
      FriendlyName?: string;
      Status?: string;
      PageSize?: string;
      Page?: string;
    };
    const { page, pageSize } = paging(query);
    const accounts = [self, ...store.accounts.subaccounts(self.accountSid)]
      .filter((account) => !query.FriendlyName || account.friendlyName === query.FriendlyName)
      .filter((account) => !query.Status || account.status === query.Status);
    return reply.send(
      pageEnvelope('accounts', `${API}/Accounts.json`, accounts.map(accountResource), page, pageSize),
    );
  });

  /**
   * A parent may fetch a child, and nobody else can — `authenticate` is what decides that.
   *
   * Readable even when suspended, so the status a caller is locked out by is one it can
   * still see. The credential still has to be an active account.
   */
  app.get(`${API}/Accounts/:sid.json`, async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const account = authenticate(request, reply, sid, { requireActive: false });
    if (!account) return;
    return reply.send(accountResource(account));
  });

  /**
   * Rename, or change a subaccount's status. A `POST`, because that is what the SDK sends.
   *
   * **`Status` is refused on a top-level account.** Suspending the account whose
   * credentials are the only ones that reach this route would lock the whole REST API out
   * of itself, with the unauthenticated Admin panel as the single way back. Twilio does
   * not let you close your project's own account here either.
   *
   * Reachable on a suspended child, so its parent can start it again — see `authenticate`.
   */
  app.post(`${API}/Accounts/:sid.json`, async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const account = authenticate(request, reply, sid, { requireActive: false });
    if (!account) return;
    const body = (request.body ?? {}) as { FriendlyName?: string; Status?: string };
    if (body.Status !== undefined) {
      if (account.parentAccountSid === null) {
        return twilioError(
          reply,
          400,
          20001,
          `${account.accountSid} is not a subaccount, and its status cannot be changed over REST`,
        );
      }
      if (!STATUSES.includes(body.Status as AccountStatus)) {
        return twilioError(reply, 400, 20001, `Status must be one of ${STATUSES.join(', ')}`);
      }
    }
    const updated = store.accounts.update(sid, {
      friendlyName: body.FriendlyName,
      status: body.Status as AccountStatus | undefined,
    });
    if (updated === null) return twilioError(reply, 404, 20404, `Account ${sid} was not found`);
    return reply.send(accountResource(updated));
  });

  /* ------------------------------------------------------------ the catch-all */

  /**
   * **Registered last, and a 501 rather than a 404.**
   *
   * Pointing a client's base URL here redirects its whole API domain, most of which
   * nothing has faked. A route that fell through to the static handler would answer 404,
   * and an SDK reports that as the resource not existing — so a gap in this simulator
   * would be read as a call that vanished. `20501` says what actually happened, and names
   * the path, so the next person knows what to add.
   */
  app.all(`${API}/*`, async (request, reply) =>
    twilioError(
      reply,
      501,
      20501,
      `${request.method} ${request.url.split('?')[0]} is not faked by localio`,
    ),
  );
}

/* ------------------------------------------------------------------ resources */

/**
 * Twilio's `Account`, which **does** carry its `auth_token` on a read — unlike every other
 * resource here, and unlike `/admin`, where the token is behind `?reveal=1`. This route is
 * authenticated and the token is the only way a caller can use the subaccount it just
 * made, so answering it is the Twilio-shaped thing to do.
 */
function accountResource(account: Account): Record<string, unknown> {
  const uri = `${API}/Accounts/${account.accountSid}`;
  return {
    sid: account.accountSid,
    friendly_name: account.friendlyName,
    status: account.status,
    // No trial tier is modelled, and 'Full' is what a real one answers.
    type: 'Full',
    auth_token: account.authToken,
    // Twilio's own field name for the parent, and it is **self** on a top-level account
    // rather than null — which is what the SDK's callers branch on.
    owner_account_sid: account.parentAccountSid ?? account.accountSid,
    date_created: rfc2822(account.createdAt),
    date_updated: rfc2822(account.createdAt),
    uri: `${uri}.json`,
    subresource_uris: {
      calls: `${uri}/Calls.json`,
      incoming_phone_numbers: `${uri}/IncomingPhoneNumbers.json`,
      messages: `${uri}/Messages.json`,
      recordings: `${uri}/Recordings.json`,
      keys: `${uri}/Keys.json`,
    },
  };
}

function callResource(call: Call, deps: Deps): Record<string, unknown> {
  const live = deps.liveCallSids().has(call.sid);
  const seconds =
    call.durationSec !== null
      ? String(call.durationSec)
      : live && call.startTime !== null
        ? String(Math.max(0, Math.floor(Date.now() / 1000) - call.startTime))
        : '';
  return {
    sid: call.sid,
    account_sid: call.accountSid,
    to: call.to,
    to_formatted: call.to,
    from: call.from,
    from_formatted: call.from,
    direction: call.direction,
    status: live && call.status === 'ringing' ? 'in-progress' : call.status,
    // A string of whole seconds, and **empty while the call is up** — which is what
    // Twilio answers, and is not the same as `"0"`.
    duration: seconds,
    start_time: rfc2822(call.startTime),
    end_time: rfc2822(call.endTime),
    date_created: rfc2822(call.createdAt),
    date_updated: rfc2822(call.endTime ?? call.createdAt),
    api_version: '2010-04-01',
    uri: `${API}/Accounts/${call.accountSid}/Calls/${call.sid}.json`,
    // Null rather than plausible. Nothing here can know any of these, and a mock that
    // invents a price is a mock somebody eventually believes.
    price: null,
    price_unit: null,
    answered_by: null,
    caller_name: null,
    forwarded_from: null,
    parent_call_sid: null,
    phone_number_sid: null,
    annotation: null,
    group_sid: null,
    queue_time: '0',
    trunk_sid: null,
    subresource_uris: {
      recordings: `${API}/Accounts/${call.accountSid}/Calls/${call.sid}/Recordings.json`,
      events: `${API}/Accounts/${call.accountSid}/Calls/${call.sid}/Events.json`,
    },
  };
}

function keyResource(key: ApiKey, secret?: string): Record<string, unknown> {
  return {
    sid: key.sid,
    friendly_name: key.friendlyName,
    date_created: rfc2822(key.createdAt),
    date_updated: rfc2822(key.updatedAt),
    // Twilio's `Key` carries no secret and no account_sid; only the `NewKey` a create
    // answers has one, which is why this is a parameter rather than a field.
    ...(secret === undefined ? {} : { secret }),
  };
}

function messageResource(message: Message): Record<string, unknown> {
  return {
    sid: message.sid,
    account_sid: message.accountSid,
    to: message.to,
    from: message.from,
    body: message.body,
    direction: message.direction,
    status: message.status,
    num_segments: String(message.numSegments),
    num_media: '0',
    error_code: message.errorCode,
    error_message: null,
    date_created: rfc2822(message.createdAt),
    date_updated: rfc2822(message.createdAt),
    date_sent: message.status === 'queued' ? null : rfc2822(message.createdAt),
    api_version: '2010-04-01',
    uri: `${API}/Accounts/${message.accountSid}/Messages/${message.sid}.json`,
    subresource_uris: { media: `${API}/Accounts/${message.accountSid}/Messages/${message.sid}/Media.json` },
    price: null,
    price_unit: null,
    messaging_service_sid: message.messagingServiceSid,
  };
}

function numberResource(number: PhoneNumber): Record<string, unknown> {
  return {
    sid: number.sid,
    account_sid: number.accountSid,
    phone_number: number.phoneNumber,
    // `friendlyName` after the SDK camelCases it. Answering camelCase here would leave
    // every optional field on the deserialized resource `undefined`.
    friendly_name: number.friendlyName,
    voice_url: number.voiceUrl,
    voice_method: number.voiceMethod,
    status_callback: number.statusCallbackUrl,
    status_callback_method: number.statusCallbackMethod,
    sms_url: number.smsUrl,
    sms_method: number.smsMethod,
    // The fields Twilio always sends, as nulls. An application reading
    // `.voiceFallbackUrl` off the SDK's resource gets `null` rather than `undefined`,
    // which is the difference between "not configured" and "this field does not exist".
    // None of them are honoured — there are no fallback webhooks here — and that is in
    // the README's list of what this is not.
    voice_fallback_url: null,
    voice_fallback_method: 'POST',
    sms_fallback_url: null,
    sms_fallback_method: 'POST',
    voice_caller_id_lookup: false,
    beta: false,
    status: 'in-use',
    address_requirements: 'none',
    address_sid: null,
    bundle_sid: null,
    trunk_sid: null,
    identity_sid: null,
    emergency_status: 'Inactive',
    emergency_address_sid: null,
    voice_receive_mode: 'voice',
    capabilities: { voice: true, sms: true, mms: true, fax: false },
    date_created: rfc2822(number.createdAt),
    date_updated: rfc2822(number.createdAt),
    api_version: '2010-04-01',
    uri: `${API}/Accounts/${number.accountSid}/IncomingPhoneNumbers/${number.sid}.json`,
    // `twilio` rather than `localio`: `origin` is an enum the SDK exposes, and a value
    // outside it is a resource an application cannot switch on.
    origin: 'twilio',
  };
}

function recordingResource(recording: Recording, config: Config): Record<string, unknown> {
  return {
    sid: recording.sid,
    account_sid: recording.accountSid,
    call_sid: recording.callSid,
    duration: String(recording.durationSec),
    channels: recording.channels,
    source: recording.source,
    status: recording.status,
    date_created: rfc2822(recording.createdAt),
    date_updated: rfc2822(recording.createdAt),
    start_time: rfc2822(recording.createdAt),
    api_version: '2010-04-01',
    uri: `${API}/Accounts/${recording.accountSid}/Recordings/${recording.sid}.json`,
    media_url: `${config.publicUrl}${API}/Accounts/${recording.accountSid}/Recordings/${recording.sid}`,
    price: null,
    price_unit: null,
    error_code: null,
  };
}

function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
