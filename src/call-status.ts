import type { Logger } from 'pino';
import type { Call, Store } from './db/index.js';
import { statusForm, type WebhookPoster, type WebhookResult } from './webhook.js';

/**
 * Call progress, reported to whoever asked to be told.
 *
 * **One place, because a call's callbacks are numbered.** The first event a placed call
 * emits (`initiated`) is posted from `POST …/Calls.json`, before any {@link CallSession}
 * exists; `ringing` and `answered` come from the session; `completed` comes from teardown;
 * and `canceled` comes from the route that declines a queued call. Five entrances, one
 * `SequenceNumber` sequence — so the posting lives here rather than at each of them.
 *
 * **Which events fire is the caller's to ask for, not ours to assume.** Twilio's
 * `StatusCallbackEvent` defaults to `completed` alone, which is what an unnamed set means
 * here too, so an application that never heard of the parameter sees exactly what it saw
 * before this existed.
 */

/** The four Twilio publishes. Anything else on a placement is not one of these. */
export const CALL_EVENTS = ['initiated', 'ringing', 'answered', 'completed'] as const;
export type CallEventName = (typeof CALL_EVENTS)[number];

export function isCallEvent(value: string): value is CallEventName {
  return (CALL_EVENTS as readonly string[]).includes(value);
}

/**
 * Read a placement's `StatusCallbackEvent` into the set that will actually fire.
 *
 * A repeated form field arrives as an array, a single one as a string, and neither as
 * nothing — `@fastify/formbody` parses with `querystring.parse`, so both shapes are
 * routine rather than exotic. Unknown values are dropped rather than refused: Twilio adds
 * event names over time, and failing a call placement over one this build has not heard
 * of would be the worse answer.
 */
export function parseEventRequest(raw: unknown): CallEventName[] | null {
  if (raw === undefined || raw === null) return null;
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter(isCallEvent);
  return values.length === 0 ? null : [...new Set(values)];
}

/**
 * Whether this call asked to hear about `event`.
 *
 * **`null` means Twilio's default**, which is `completed` and nothing else. Resolved here
 * rather than written into the row, so a row stored by an older build cannot disagree
 * with the default this build believes in.
 */
export function wants(call: Call, event: CallEventName): boolean {
  return (call.statusCallbackEvents ?? ['completed']).includes(event);
}

export interface CallStatusDeps {
  store: Store;
  poster: WebhookPoster;
  logger: Logger;
}

/**
 * Post one call-progress callback, if this call asked for it and something is listening.
 *
 * Never throws: `WebhookPoster` turns a transport failure into a status of `0`, and a
 * status callback that could not be delivered must not take the call down with it.
 * Answers `null` when nothing was posted — the call did not ask for this event, or nobody
 * named a URL — which is how a caller knows there is nothing to show the page.
 *
 * `authToken` is the **owning account's**, which for a call placed with a parent's
 * credentials at a child's path is the child's — the same rule `call.ts` signs the voice
 * webhook under, and the reason `authenticate()` returns the account the URL names.
 */
export async function postCallStatus(
  deps: CallStatusDeps,
  input: {
    call: Call;
    event: CallEventName;
    /** What `CallStatus` should say, which is not always the event name. */
    status: string;
    authToken: string;
    /** The number the call is on, for the `status_callback` a placement did not name. */
    fallbackUrl?: string | null;
    durationSeconds?: number;
  },
): Promise<WebhookResult | null> {
  const { call, event } = input;
  if (!wants(call, event)) return null;

  const url = call.statusCallbackUrl || input.fallbackUrl || '';
  if (!url) return null;

  const form = statusForm({
    callSid: call.sid,
    accountSid: call.accountSid,
    from: call.from,
    to: call.to,
    direction: call.direction,
    status: input.status,
    durationSeconds: input.durationSeconds ?? call.durationSec ?? 0,
    sequenceNumber: deps.store.calls.nextCallbackSeq(call.sid),
  });

  const result = await deps.poster.post(
    url,
    input.authToken,
    form,
    call.statusCallbackMethod === 'GET' ? 'GET' : 'POST',
    { kind: 'status', callSid: call.sid },
  );

  deps.store.calls.log(call.sid, 'webhook', {
    kind: 'status',
    event,
    status: input.status,
    url,
    answered: result.status,
  });
  if (result.status < 200 || result.status >= 300) {
    deps.logger.warn(
      { callSid: call.sid, event, url, status: result.status },
      'a call status callback was not accepted',
    );
  }
  return result;
}
