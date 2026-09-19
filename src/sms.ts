import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Message, MessageStatus, Store } from './db/index.js';
import { parseTwiml } from './twiml/parse.js';
import { attr } from './twiml/parse.js';
import { messageForm, messageStatusForm, type WebhookPoster } from './webhook.js';

/**
 * Carrying a text between two numbers.
 *
 * **This is the half that makes "SMS between two numbers" true.** A message reaches this
 * simulator one of two ways — the application under test calling `POST …/Messages.json`,
 * or somebody injecting one from the UI — and both end here. What happens next depends on
 * whether the destination is a number this simulator holds:
 *
 * - **It is, and it has an `sms_url`.** The message is delivered: a signed inbound
 *   messaging webhook goes to that URL, and any `<Message>` in the TwiML that comes back
 *   is stored as a reply *and delivered in turn*. That is a full round trip between two
 *   local numbers with no Twilio anywhere.
 * - **It is not.** The message is stored as outbound and left. Nobody is on the other
 *   end, which is exactly what sending to an unheld number means.
 *
 * The app this was extracted from could not do the first of those. It delivered a text by
 * asking the application for a *synchronous* reply through a private query parameter, and
 * read the conversation back out of that application's own database. Both are gone: a
 * message here is delivered the way Twilio delivers one, and the thread is this
 * simulator's own rows.
 *
 * **Two numbers texting each other could bounce forever** if each auto-replies, so
 * `depth` is carried across the hop and a reply to a reply to a reply stops. It is not a
 * hypothetical: two echo servers pointed at each other is the first thing anybody tries.
 */

/** How many replies deep one message may go before this calls it a loop. */
const MAX_DEPTH = 5;

export interface DeliveryResult {
  message: Message;
  /** What the destination's webhook answered, if there was one to ask. */
  webhook: { status: number; body: string; url: string } | null;
  /** The reply it carried, already stored and delivered. */
  reply: Message | null;
  note?: string;
}

export interface SmsServiceOptions {
  store: Store;
  poster: WebhookPoster;
  config: Config;
  logger: Logger;
}

export class SmsService {
  private readonly store: Store;
  private readonly poster: WebhookPoster;
  private readonly logger: Logger;

  constructor(options: SmsServiceOptions) {
    this.store = options.store;
    this.poster = options.poster;
    this.logger = options.logger;
  }

  /**
   * Store a message and try to deliver it.
   *
   * `accountSid` is the account the *sender* is on where we know it — which we do for a
   * REST send, and do not for a message injected from an arbitrary outside number. In the
   * second case the destination's account is used, because that is whose webhook will be
   * signed and whose `AccountSid` the form must carry.
   */
  async send(input: {
    from: string;
    to: string;
    body: string;
    accountSid?: string;
    direction?: 'inbound' | 'outbound-api' | 'outbound-reply';
    depth?: number;
    /**
     * Where to report this message's delivery status, from the sender's own
     * `StatusCallback`. **Not inherited by a reply** — see {@link deliverReply}.
     */
    statusCallbackUrl?: string | null;
    messagingServiceSid?: string | null;
  }): Promise<DeliveryResult> {
    const destination = this.store.numbers.findByNumber(input.to);
    const origin = this.store.numbers.findByNumber(input.from);
    // The sender's own account when the sender is ours; otherwise the destination's,
    // since that is the account whose token the webhook must be signed with.
    const accountSid =
      input.accountSid ?? origin?.accountSid ?? destination?.accountSid ?? '';

    const message = this.store.messages.create({
      accountSid,
      from: input.from,
      to: input.to,
      body: input.body,
      direction: input.direction ?? (origin ? 'outbound-api' : 'inbound'),
      statusCallbackUrl: input.statusCallbackUrl ?? null,
      messagingServiceSid: input.messagingServiceSid ?? null,
    });

    if (destination === null) {
      // Stored and left. A real Twilio would try to deliver to a carrier; there is no
      // carrier here, and claiming `delivered` would be inventing an outcome.
      return {
        message: await this.settle(message, 'sent'),
        webhook: null,
        reply: null,
        note: `${input.to} is not a number this simulator holds, so nothing was notified`,
      };
    }

    // **A pool's inbound URL wins over the number's own**, which is the whole point of a
    // pool: one handler for many numbers, instead of the same `sms_url` pasted onto each.
    // A service with no `inbound_request_url` changes nothing here — joining a pool must
    // never silently move a number's inbound traffic somewhere it was not told about.
    //
    // This sits *above* the `smsUrl` check on purpose: below it, a pooled number with no
    // `sms_url` of its own would be answered `delivered` and never reach the pool's handler
    // at all, which is the one arrangement a pool is most likely to be set up as.
    const service = this.store.messagingServices.findForNumber(destination.sid);
    const inbound = service?.inboundRequestUrl
      ? { url: service.inboundRequestUrl, method: service.inboundMethod, via: service.sid }
      : { url: destination.smsUrl, method: destination.smsMethod, via: null };

    if (!inbound.url) {
      return {
        message: await this.settle(message, 'delivered'),
        webhook: null,
        reply: null,
        note: `${destination.phoneNumber} has no sms_url, so the message was stored but nothing was called`,
      };
    }

    const account = this.store.accounts.find(destination.accountSid);
    if (account === null) {
      return {
        message: await this.settle(message, 'failed', 30001),
        webhook: null,
        reply: null,
        note: 'the account holding the destination number no longer exists',
      };
    }

    const result = await this.poster.post(
      inbound.url,
      // The **destination account's** token, pool or no pool: it is that application
      // verifying this signature. A pool cannot straddle accounts — every write site
      // refuses it — so the service never moves which token this is.
      account.authToken,
      messageForm({
        messageSid: message.sid,
        accountSid: account.accountSid,
        from: message.from,
        to: message.to,
        body: message.body,
        numSegments: message.numSegments,
        messagingServiceSid: inbound.via,
      }),
      inbound.method === 'GET' ? 'GET' : 'POST',
      { kind: 'message', messageSid: message.sid },
    );

    const ok = result.status >= 200 && result.status < 300;
    const settled = await this.settle(message, ok ? 'delivered' : 'failed', ok ? null : 30003);

    const reply = ok
      ? await this.deliverReply(result.body, destination.phoneNumber, message.from, account.accountSid, input.depth ?? 0)
      : null;

    return {
      message: settled,
      webhook: { status: result.status, body: result.body, url: result.url },
      reply,
    };
  }

  /**
   * A `<Message>` in the webhook's own TwiML: the reply that never goes near the REST API.
   *
   * Stored as `outbound-reply` — a third direction Twilio does not have — because it is
   * worth being able to see which of a number's outbound messages came back inline and
   * which were sent later over `Messages.json`. They are the same to the recipient and
   * very different to debug.
   */
  private async deliverReply(
    body: string,
    from: string,
    to: string,
    accountSid: string,
    depth: number,
  ): Promise<Message | null> {
    if (!body.trim()) return null;
    let replies: Array<{ text: string; to?: string; from?: string }>;
    try {
      replies = parseTwiml(body)
        .verbs.filter((verb) => verb.name === 'Message')
        // Not trimmed: the whitespace in a reply is part of the reply. `to` and `from`
        // are honoured because a document may legitimately answer somebody else.
        .map((verb) => ({ text: verb.text, to: attr(verb, 'to'), from: attr(verb, 'from') }));
    } catch (error) {
      this.logger.warn({ err: error }, 'a messaging webhook answered something that is not twiml');
      return null;
    }
    if (replies.length === 0) {
      // An empty `<Response/>` is a result: the application had nothing to say. That is
      // deliberately the same document for "no handler" and "the turn produced nothing",
      // and this simulator must not guess which.
      return null;
    }
    if (depth >= MAX_DEPTH) {
      this.logger.warn({ from, to, depth }, 'stopping an sms reply chain that would not end');
      return null;
    }

    let last: Message | null = null;
    for (const reply of replies) {
      const delivered = await this.send({
        from: reply.from ?? from,
        to: reply.to ?? to,
        body: reply.text,
        accountSid,
        direction: 'outbound-reply',
        depth: depth + 1,
      });
      last = delivered.message;
    }
    return last;
  }

  /**
   * Write a message's final status, and tell whoever asked to be told.
   *
   * **Every status this class writes goes through here**, which is the only reason the
   * four ways a message can end are all reported. They were not: three of them returned
   * before the single call site that posted anything, so a message to a number this
   * simulator does not hold simply went quiet — the one outcome a simulator exists to
   * make legible.
   *
   * The callback is the **sender's**, named on that message, and it is signed with the
   * **sender's** auth token. Both halves matter and neither used to be true: it was read
   * off the destination number's row and signed with the destination account's token, so
   * an application validating the signature the way Twilio's SDK does rejected it with
   * nothing naming why.
   *
   * Awaited rather than fired and forgotten. A status callback is part of what sending a
   * message did, and `send()` is already the slow path its callers await.
   */
  private async settle(
    message: Message,
    status: MessageStatus,
    errorCode: number | null = null,
  ): Promise<Message> {
    const stored = this.store.messages.setStatus(message.sid, status, errorCode);
    const settled: Message = stored ?? { ...message, status, errorCode };
    const url = settled.statusCallbackUrl;
    if (!url) return settled;

    // The sender's account, not the destination's. For a REST send that is the
    // authenticated account; for a message injected from an outside number it is the one
    // resolved in `send()`, which is the account whose webhook this describes either way.
    const account = this.store.accounts.find(settled.accountSid);
    if (account === null) {
      this.logger.warn(
        { messageSid: settled.sid, accountSid: settled.accountSid },
        'no account to sign a message status callback with, so none was posted',
      );
      return settled;
    }

    await this.poster.post(
      url,
      account.authToken,
      messageStatusForm({
        messageSid: settled.sid,
        accountSid: settled.accountSid,
        from: settled.from,
        to: settled.to,
        status,
        errorCode,
      }),
      'POST',
      { kind: 'message-status', messageSid: settled.sid },
    );
    return settled;
  }
}
