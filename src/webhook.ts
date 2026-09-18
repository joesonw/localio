import type { Logger } from 'pino';
import { preview } from './log.js';
import { signRequest } from './signature.js';

/**
 * Posting a webhook the way Twilio posts one.
 *
 * **One URL.** The app this was extracted from carried two — a URL to sign against and a
 * URL to send to — because a signature is computed over what the receiver reconstructs
 * and in development that was a tunnel while the POST went to localhost. The whole of its
 * "when every webhook comes back 403" documentation existed because those two could
 * disagree. Here a number's `voice_url` is a column, it is both, and they cannot.
 *
 * That leaves one rule, which is Twilio's and is not negotiable: **a signature covers the
 * exact URL requested, query string included**. So a URL is signed as given — never
 * rebuilt from a path, never with a parameter appended after signing.
 *
 * **Nothing here throws.** A refused connection, a timeout and a 403 are all outcomes
 * this app exists to make legible, so they come back as a {@link WebhookResult} — a
 * transport failure as status `0`, which no HTTP response can be. A caller that had to
 * distinguish an exception from a status would end up with two paths to the same event
 * log line.
 *
 * **And it is the one place a webhook is logged**, for the same reason it is the one place
 * `fetch` is called: every outbound request passes through {@link WebhookPoster.send}, so a
 * line emitted there cannot be the line some future call site forgot. The per-call event
 * log in SQLite is the browser's record and only the browser's; this is the terminal's.
 * What goes out at `info` is the shape of the request — kind, method, URL, status, ms —
 * and the bodies wait for `--log-level debug`, because a TwiML document per webhook is a
 * firehose on a busy call and the one thing you want when a call misbehaves.
 *
 * The auth token is never logged and neither are the request headers, so the signature
 * cannot leak into a paste of the terminal. `params` is the signed form and, as above, is
 * never a token.
 */

export interface WebhookResult {
  status: number;
  body: string;
  url: string;
  /** The form as it was signed and sent, for the event log. Never a token. */
  params: Record<string, string>;
  method: WebhookMethod;
  /** Wall clock around the `fetch`, including the time a refused connection took to refuse. */
  durationMs: number;
}

export type WebhookMethod = 'POST' | 'GET';

/**
 * What the caller knows about *why* it is posting, for the log line only.
 *
 * Every call site already computes a `kind` for `store.calls.log`; passing the same string
 * here is what makes a terminal line and a panel row name the same event. Nothing in this
 * file branches on any of it.
 */
export interface WebhookContext {
  kind?: string;
  callSid?: string;
  messageSid?: string;
}

export interface WebhookPosterOptions {
  timeoutMs: number;
  logger: Logger;
}

export class WebhookPoster {
  constructor(private readonly options: WebhookPosterOptions) {}

  /**
   * Sign and send one form.
   *
   * `method` is honoured because a number's `voice_method` may say `GET`, and Twilio's
   * `GET` is genuinely different: the parameters go on the query string, and **the
   * signature is then computed over the URL with them on it and an empty body** rather
   * than over the form. Getting that backwards is a blanket 403 on exactly the
   * configurations nobody tests.
   */
  async post(
    url: string,
    authToken: string,
    params: Record<string, string>,
    method: WebhookMethod = 'POST',
    context: WebhookContext = {},
  ): Promise<WebhookResult> {
    if (method === 'GET') return this.get(url, authToken, params, context);

    // The body is built once and both signed and sent from it. Signing a different map
    // from the one posted is the other way to make every webhook look forged.
    const body = new URLSearchParams(params).toString();
    const signature = signRequest(authToken, url, params);
    return this.send(url, params, context, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      body,
    });
  }

  private async get(
    url: string,
    authToken: string,
    params: Record<string, string>,
    context: WebhookContext,
  ): Promise<WebhookResult> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    const full = target.toString();
    // No form parameters in the payload: on a GET they are already in the URL, and
    // appending them again would sign a string no receiver will ever rebuild.
    const signature = signRequest(authToken, full, {});
    return this.send(full, params, context, {
      method: 'GET',
      headers: { 'x-twilio-signature': signature },
    });
  }

  private async send(
    url: string,
    params: Record<string, string>,
    context: WebhookContext,
    init: RequestInit,
  ): Promise<WebhookResult> {
    const method: WebhookMethod = init.method === 'GET' ? 'GET' : 'POST';
    const started = Date.now();
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const body = await response.text();
      const result: WebhookResult = {
        status: response.status,
        body,
        url,
        params,
        method,
        durationMs: Date.now() - started,
      };
      this.log(context, result);
      return result;
    } catch (error: unknown) {
      const result: WebhookResult = {
        // No HTTP response can be `0`, which is what makes a transport failure tellable
        // from a 5xx without a second field.
        status: 0,
        body: error instanceof Error ? error.message : String(error),
        url,
        params,
        method,
        durationMs: Date.now() - started,
      };
      this.log(context, result);
      return result;
    }
  }

  /**
   * One line out, plus the bodies at `debug`.
   *
   * A `status: 0` is a `warn` rather than an `info`: nothing here throws, so this line is
   * the only place a refused connection or a timeout is announced, and it should not read
   * like a delivery. Everything an HTTP server actually answered — a 403, a 404, an empty
   * document — stays at `info`, because those are outcomes this tool exists to show rather
   * than faults of its own.
   */
  private log(context: WebhookContext, result: WebhookResult): void {
    const { logger } = this.options;
    const line = {
      kind: context.kind,
      callSid: context.callSid,
      messageSid: context.messageSid,
      method: result.method,
      url: result.url,
      status: result.status,
      ms: result.durationMs,
    };
    if (result.status === 0) logger.warn({ ...line, error: result.body }, 'webhook failed');
    else logger.info(line, 'webhook');
    // Guarded so a TwiML document is not stringified and truncated at `info`, which is
    // every run that is not actively being debugged.
    if (logger.isLevelEnabled('debug')) {
      logger.debug(
        { kind: context.kind, url: result.url, params: result.params, body: preview(result.body) },
        'webhook body',
      );
    }
  }
}

/** Every form below carries this. It is signed, so it is not decoration. */
const API_VERSION = '2010-04-01';

export interface CallFacts {
  callSid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: string;
}

/**
 * The form a voice webhook carries.
 *
 * The fields Twilio really sends for a call that is ringing, rather than the two a given
 * handler happens to read — being a provider means sending what a provider sends, and an
 * application that grows a third field should not have to be told about this simulator to
 * start receiving it.
 */
export function voiceForm(facts: CallFacts, status = 'ringing'): Record<string, string> {
  return {
    CallSid: facts.callSid,
    AccountSid: facts.accountSid,
    From: facts.from,
    To: facts.to,
    Caller: facts.from,
    Called: facts.to,
    Direction: facts.direction,
    CallStatus: status,
    ApiVersion: API_VERSION,
  };
}

/**
 * The form a status callback carries, once the call is over.
 *
 * Sending it is what makes this a provider rather than half of one — the status callback
 * is the route an application is least likely to have exercised, because nothing but a
 * real provider posts it.
 */
export function statusForm(
  facts: CallFacts & { durationSeconds: number; status: string },
): Record<string, string> {
  return {
    CallSid: facts.callSid,
    AccountSid: facts.accountSid,
    From: facts.from,
    To: facts.to,
    Direction: facts.direction,
    CallStatus: facts.status,
    CallDuration: String(facts.durationSeconds),
    ApiVersion: API_VERSION,
  };
}

/**
 * The form an inbound message webhook carries.
 *
 * **There is no `Direction`, and that is Twilio's shape rather than an omission.** An
 * inbound message carries none, which is why a messaging webhook resolves its number off
 * `To` unconditionally where a voice one branches on direction. `To` is always a number
 * this simulator holds and `From` is always the other party.
 *
 * `MessageSid`, `SmsSid` and `SmsMessageSid` are the same value three times. Twilio sends
 * all three for compatibility with its own older messaging API, and every one of them is
 * signed — so leaving two out would not merely send less, it would send a different body
 * from the one a real webhook has.
 */
export function messageForm(facts: {
  messageSid: string;
  accountSid: string;
  from: string;
  to: string;
  body: string;
  numSegments?: number;
}): Record<string, string> {
  return {
    MessageSid: facts.messageSid,
    SmsSid: facts.messageSid,
    SmsMessageSid: facts.messageSid,
    AccountSid: facts.accountSid,
    From: facts.from,
    To: facts.to,
    Body: facts.body,
    NumMedia: '0',
    NumSegments: String(facts.numSegments ?? 1),
    ApiVersion: API_VERSION,
  };
}

/** What a `<Record>`'s `action` and its `recordingStatusCallback` carry beyond the call's own facts. */
export function recordingForm(
  facts: CallFacts,
  recording: {
    recordingSid: string;
    recordingUrl: string;
    durationSeconds: number;
    channels?: number;
    /** The key that ended it, or `hangup`. Twilio sends this on the `action` request. */
    digits?: string;
  },
): Record<string, string> {
  const form: Record<string, string> = {
    ...voiceForm(facts, 'in-progress'),
    RecordingSid: recording.recordingSid,
    RecordingUrl: recording.recordingUrl,
    RecordingDuration: String(recording.durationSeconds),
    RecordingChannels: String(recording.channels ?? 1),
    RecordingStatus: 'completed',
    RecordingSource: 'RecordVerb',
  };
  if (recording.digits !== undefined) form.Digits = recording.digits;
  return form;
}

/** A message's delivery status, posted to a number's `sms_status_callback_url`. */
export function messageStatusForm(facts: {
  messageSid: string;
  accountSid: string;
  from: string;
  to: string;
  status: string;
}): Record<string, string> {
  return {
    MessageSid: facts.messageSid,
    SmsSid: facts.messageSid,
    SmsStatus: facts.status,
    MessageStatus: facts.status,
    AccountSid: facts.accountSid,
    From: facts.from,
    To: facts.to,
    ApiVersion: API_VERSION,
  };
}
