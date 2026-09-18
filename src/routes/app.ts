import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallClaims } from '../call-claims.js';
import type { CallFeed, CallFeedKind } from '../call-feed.js';
import type { Config } from '../config.js';
import type { Call, Message, Recording, Store } from '../db/index.js';
import type { SmsService } from '../sms.js';

/**
 * What the UI reads and drives.
 *
 * Everything under `/api` is this process talking to its own page: the call and message
 * history, the calls waiting to be answered, and the one route that injects an inbound
 * message from an arbitrary number. None of it is Twilio's shape — that is `/2010-04-01`'s
 * job — so the fields are the ones the page actually draws.
 *
 * **Unauthenticated, like everything else here.** These serve what this simulator itself
 * remembers, which includes the body of every message it has carried. A message body is
 * what somebody was actually told; if this app ever faces a browser somebody else can
 * reach, this file goes behind a session hook in the same change.
 */

const claimBody = z.object({
  /** A page's own id, one per load. Not a sid and not a credential — just who is trying. */
  holder: z.string().min(1).max(64),
});

const sendBody = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  body: z.string().max(1600),
});

interface Deps {
  store: Store;
  sms: SmsService;
  config: Config;
  liveCallSids: () => Set<string>;
  claims: CallClaims;
  feed: CallFeed;
}

export function registerApp(app: FastifyInstance, deps: Deps): void {
  const { store, sms, config, claims, feed } = deps;

  /**
   * Say a pending call moved, **after** it already has.
   *
   * Read back out of the store rather than trusting the row the caller happened to hold,
   * so a frame can never describe a state a following `GET /api/calls` would contradict.
   */
  const announce = (kind: CallFeedKind, sid: string): void => {
    const call = store.calls.find(sid);
    if (call === null) return;
    feed.publish({ kind, call, claimedBy: claims.heldBy(sid) });
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Booleans and counts. **Never a token** — that is `/admin/accounts/:sid?reveal=1`. */
  app.get('/api/settings', async () => ({
    public_url: config.publicUrl,
    stream_url_override: config.streamUrlOverride,
    webhook_timeout_ms: config.webhookTimeoutMs,
    accounts: store.accounts.list().length,
    numbers: store.numbers.list().length,
    api_keys: store.apiKeys.list().length,
    live_calls: deps.liveCallSids().size,
    // The one way to see from outside that the push channel is actually carrying anybody.
    call_stream_clients: feed.size,
  }));

  /* ------------------------------------------------------------------- calls */

  app.get('/api/calls', async (request) => {
    const query = request.query as { status?: string; number?: string; limit?: string };
    const status = query.status as Call['status'] | undefined;
    // `number` is what the page's handset picker is set to — either end of the call.
    const calls = store.calls.list({
      status,
      number: query.number,
      limit: Number.parseInt(query.limit ?? '100', 10) || 100,
    });
    const live = deps.liveCallSids();
    return { calls: calls.map((call) => callView(call, live.has(call.sid), claims)) };
  });

  app.get('/api/calls/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const call = store.calls.find(sid);
    if (call === null) return reply.code(404).send({ error: 'not_found' });
    return {
      ...callView(call, deps.liveCallSids().has(call.sid), claims),
      events: store.calls.events(sid),
      recordings: store.recordings.list({ callSid: sid }).map((r) => recordingView(r, config)),
    };
  });

  app.get('/api/calls/:sid/events', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    if (store.calls.find(sid) === null) return reply.code(404).send({ error: 'not_found' });
    return { events: store.calls.events(sid) };
  });

  /**
   * Decline a ringing call.
   *
   * **No webhook is posted at all**, which is the point: a call nobody picked up never
   * reached the application, so telling it one did would be inventing a call. The row
   * stays, as `canceled`, because a placement that was declined is worth still being able
   * to see.
   */
  app.delete('/api/calls/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    if (!store.calls.cancel(sid)) {
      return reply.code(409).send({
        error: 'not_queued',
        message: 'that call is not waiting to be answered — it may already have been taken',
      });
    }
    // Unconditional: the call is gone, so whoever was mid-pickup has nothing left to hold.
    claims.release(sid);
    // Released first, so the frame carries `claimed_by: null` and no tab is left drawing a
    // row as "being picked up" that no longer exists.
    announce('declined', sid);
    return reply.code(204).send();
  });

  /* ------------------------------------------------------------------ claims */

  /**
   * Say you are picking this call up.
   *
   * **This is not what makes answering once-only** — `Calls.answer()` is, and it stays
   * that way. Answering does not reach the server until the `dial` frame does, which is
   * after the page has opened a socket and asked for the microphone; without this, two
   * tabs walk through that whole prompt and the loser only learns at the end. A claim on
   * the click lets every other tab grey the row out on its next poll instead.
   *
   * It expires, because the tab that claims and then dies is not coming back to release
   * it, and a call nobody can answer is worse than a call two tabs briefly raced for.
   */
  app.post('/api/calls/:sid/claim', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const parsed = claimBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', message: 'holder is required' });
    }
    const call = store.calls.find(sid);
    if (call === null || call.status !== 'queued') {
      return reply.code(409).send({
        error: 'not_queued',
        message: 'that call is not waiting to be answered — it may already have been taken',
      });
    }
    if (!claims.claim(sid, parsed.data.holder)) {
      return reply.code(409).send({
        error: 'already_claimed',
        message: 'another tab is picking that call up',
      });
    }
    announce('claimed', sid);
    return { holder: parsed.data.holder, expires_at: claims.expiresAt(sid) };
  });

  /** Give it back — after a failed pickup. A holder that no longer holds it is a no-op. */
  app.delete('/api/calls/:sid/claim', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const { holder } = request.query as { holder?: string };
    // A release that changed nothing is not news: `release` is a no-op for a holder that
    // no longer holds it, and announcing anyway would tell every tab to re-enable a button
    // for a call somebody else is now mid-pickup on.
    const held = claims.heldBy(sid) !== null;
    claims.release(sid, holder);
    if (held && claims.heldBy(sid) === null) announce('released', sid);
    return reply.code(204).send();
  });

  /* ---------------------------------------------------------------- messages */

  app.get('/api/messages', async (request) => {
    const query = request.query as { a?: string; b?: string; limit?: string };
    const limit = Number.parseInt(query.limit ?? '200', 10) || 200;
    if (query.a && query.b) {
      return { messages: store.messages.thread(query.a, query.b, limit).map(messageView) };
    }
    return { messages: store.messages.list({ limit }).map(messageView) };
  });

  app.get('/api/threads', async (request) => {
    const query = request.query as { number?: string; limit?: string };
    const threads = store.messages.threads({
      number: query.number,
      limit: Number.parseInt(query.limit ?? '50', 10) || 50,
    });
    return { threads: threads.map(threadView) };
  });

  /**
   * Send a message as if it came from outside.
   *
   * This is the inbound half that has no REST equivalent: a real person texting one of
   * this simulator's numbers. It goes through the same {@link SmsService} a
   * `POST …/Messages.json` does, so it is delivered the same way and any `<Message>` reply
   * lands in the same thread.
   */
  app.post('/api/messages', async (request, reply) => {
    const parsed = sendBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    }
    const result = await sms.send({ ...parsed.data, direction: 'inbound' });
    return {
      message: messageView(result.message),
      webhook: result.webhook,
      reply: result.reply ? messageView(result.reply) : null,
      note: result.note ?? null,
    };
  });

  /* -------------------------------------------------------------- recordings */

  app.get('/api/recordings', async (request) => {
    const query = request.query as { call_sid?: string; limit?: string };
    const recordings = store.recordings.list({
      callSid: query.call_sid,
      limit: Number.parseInt(query.limit ?? '100', 10) || 100,
    });
    return { recordings: recordings.map((r) => recordingView(r, config)) };
  });

  app.get('/api/recordings/:sid', async (request, reply) => {
    const { sid } = request.params as { sid: string };
    const recording = store.recordings.find(sid);
    if (recording === null) return reply.code(404).send({ error: 'not_found' });
    return recordingView(recording, config);
  });

  /* ------------------------------------------------------------------ stream */

  /**
   * Every change to a call waiting to be picked up, pushed.
   *
   * The Phone panel's pending strip is otherwise a two-second poll, which is late for both
   * halves of what it shows: a call your application just placed, and a call another tab
   * is mid-pickup on. The claim exists to tell the losing tab *early* — before it spends a
   * microphone prompt — and a poll gives most of that window straight back.
   *
   * **Advisory, like everything else on this path.** `Calls.answer()`'s conditional UPDATE
   * is still the only thing that makes a pickup happen once, the claim is still the only
   * hint before it, and the page keeps its poll: a stream that dropped a frame, or never
   * connected at all, heals on the next tick. Nothing may be built here that the poll
   * could not also produce.
   *
   * Written straight onto the socket rather than through a plugin, which is why
   * `reply.hijack()` comes first — without it Fastify serializes a second reply onto a
   * response that already has its headers out.
   */
  app.get('/api/calls/stream', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Proxies that buffer would hold a frame until the response ended, which for this
      // one is never. Harmless when nothing is in front of us.
      'x-accel-buffering': 'no',
    });

    const write = (text: string): void => {
      // A socket that went away between the event and this line is not an error: the
      // `close` handler below is already on its way.
      if (!reply.raw.writableEnded) reply.raw.write(text);
    };

    // The state a page needs to draw the strip without a follow-up fetch — and what makes
    // a reconnect self-correcting, since `EventSource` retries on its own and every
    // attempt starts here.
    write(`retry: ${STREAM_RETRY_MS}\n\n`);
    write(
      sseFrame('snapshot', {
        calls: pendingView(),
      }),
    );

    const ping = setInterval(() => write(': ping\n\n'), STREAM_PING_MS);
    // Nothing about an idle stream should hold the process open.
    ping.unref();

    const done = (): void => {
      clearInterval(ping);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    const unsubscribe = feed.subscribe({
      event: (event) =>
        write(
          sseFrame(event.kind, {
            kind: event.kind,
            call: callView(event.call, deps.liveCallSids().has(event.call.sid), claims),
          }),
        ),
      // Shutdown. An SSE response never ends on its own, and `app.close()` waits on open
      // connections — see `LocalioServer.close()`.
      close: done,
    });

    request.raw.on('close', done);
  });

  function pendingView(): Array<Record<string, unknown>> {
    const live = deps.liveCallSids();
    return store.calls
      .list({ status: 'queued' })
      .map((call) => callView(call, live.has(call.sid), claims));
  }
}

/** How long a page should wait before reconnecting a dropped stream. */
const STREAM_RETRY_MS = 2000;
/** A comment often enough that an idle stream is not mistaken for a dead one. */
const STREAM_PING_MS = 15_000;

/**
 * One SSE frame.
 *
 * Pure, and exported, because the wire format is the one part of the stream that a
 * hermetic test can hold: every line of the payload needs its own `data:` prefix, and the
 * blank line at the end is what makes the frame a frame rather than the start of the next
 * one. `JSON.stringify` never emits a raw newline, so the split is belt and braces — and
 * it is exactly the belt that is missing when somebody later passes a string through here.
 */
export function sseFrame(event: string, data: unknown): string {
  const body = JSON.stringify(data) ?? 'null';
  const lines = body.split('\n').map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join('\n')}\n\n`;
}

function callView(call: Call, live: boolean, claims: CallClaims): Record<string, unknown> {
  return {
    sid: call.sid,
    account_sid: call.accountSid,
    from: call.from,
    to: call.to,
    direction: call.direction,
    status: call.status,
    live,
    // Who is mid-pickup, so every other tab can disable its own button. A page compares
    // this against its own holder id; it means nothing to anybody else.
    claimed_by: claims.heldBy(call.sid),
    answer_url: call.answerUrl,
    status_callback_url: call.statusCallbackUrl,
    start_time: call.startTime,
    end_time: call.endTime,
    duration_sec: call.durationSec,
    created_at: call.createdAt,
  };
}

/**
 * A conversation as the picker draws it: who, when, and the one line it shows underneath.
 *
 * snake_case like everything else under `/api` — the store's camelCase stops here.
 */
function threadView(thread: {
  a: string;
  b: string;
  lastAt: number;
  count: number;
  lastBody: string;
  lastFrom: string;
}): Record<string, unknown> {
  return {
    a: thread.a,
    b: thread.b,
    last_at: thread.lastAt,
    count: thread.count,
    last_body: thread.lastBody,
    last_from: thread.lastFrom,
  };
}

function messageView(message: Message): Record<string, unknown> {
  return {
    sid: message.sid,
    account_sid: message.accountSid,
    from: message.from,
    to: message.to,
    body: message.body,
    direction: message.direction,
    status: message.status,
    num_segments: message.numSegments,
    error_code: message.errorCode,
    created_at: message.createdAt,
  };
}

function recordingView(recording: Recording, config: Config): Record<string, unknown> {
  return {
    sid: recording.sid,
    call_sid: recording.callSid,
    account_sid: recording.accountSid,
    duration_sec: recording.durationSec,
    channels: recording.channels,
    source: recording.source,
    status: recording.status,
    created_at: recording.createdAt,
    // The same URL the application under test was handed, so what the page plays and
    // what the `action` callback pointed at cannot be two different files.
    url: `${config.publicUrl}/2010-04-01/Accounts/${recording.accountSid}/Recordings/${recording.sid}`,
  };
}
