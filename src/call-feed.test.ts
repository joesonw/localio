import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallFeed, type CallFeedEvent, type CallFeedKind } from './call-feed.js';
import type { Call } from './db/index.js';

/**
 * The fan-out behind `/api/calls/stream`.
 *
 * **None of this is what makes a call answerable once** — that is the conditional UPDATE
 * in `Calls.answer()`, covered by `db/db.test.ts`. What these hold is the narrower
 * property the feed exists for: that one subscriber cannot cost the others their event,
 * and that a shutdown lets every open stream go rather than leaving one to hang the
 * process.
 */

const call = (sid: string): Call => ({
  sid,
  accountSid: 'ACtest',
  from: '+15550000001',
  to: '+15559999999',
  direction: 'outbound-api',
  status: 'queued',
  answerUrl: null,
  answerTwiml: null,
  answerMethod: 'POST',
  statusCallbackUrl: null,
  statusCallbackMethod: 'POST',
  statusCallbackEvents: null,
  startTime: null,
  endTime: null,
  durationSec: null,
  createdAt: 0,
});

const event = (kind: CallFeedKind, sid = 'CA1'): CallFeedEvent => ({
  kind,
  call: call(sid),
  claimedBy: null,
});

test('a subscriber gets every event until it unsubscribes', () => {
  const feed = new CallFeed();
  const seen: string[] = [];
  const stop = feed.subscribe({ event: (e) => seen.push(e.kind) });

  feed.publish(event('ringing'));
  feed.publish(event('claimed'));
  assert.deepEqual(seen, ['ringing', 'claimed']);
  assert.equal(feed.size, 1);

  stop();
  feed.publish(event('taken'));
  assert.deepEqual(seen, ['ringing', 'claimed']);
  assert.equal(feed.size, 0);

  // A stream whose socket dropped twice is the same stream gone once.
  stop();
  assert.equal(feed.size, 0);
});

/** An SSE response whose socket has just gone unsubscribes from inside its own handler. */
test('unsubscribing during a dispatch does not skip the rest', () => {
  const feed = new CallFeed();
  const seen: string[] = [];
  const stop = feed.subscribe({
    event: () => {
      stop();
    },
  });
  feed.subscribe({ event: (e) => seen.push(`second:${e.kind}`) });

  feed.publish(event('ringing'));
  assert.deepEqual(seen, ['second:ringing']);
  assert.equal(feed.size, 1);
});

/**
 * The whole reason this feed exists is that a second tab greys its button out *in time*.
 * One broken subscriber taking the rest down would hand that window straight back.
 */
test('a subscriber that throws does not cost the others their event', () => {
  const feed = new CallFeed();
  const seen: string[] = [];
  feed.subscribe({
    event: () => {
      throw new Error('this socket is gone');
    },
  });
  feed.subscribe({ event: (e) => seen.push(e.kind) });

  feed.publish(event('claimed'));
  assert.deepEqual(seen, ['claimed']);
  // The thrower is still subscribed: it leaves by its own `close` handler, not by this.
  assert.equal(feed.size, 2);
});

/**
 * Shutdown. An SSE response never ends on its own and Fastify's close waits on open
 * connections, so `close()` has to *tell* each one rather than merely forget it.
 */
test('close lets every subscriber go, and says so', () => {
  const feed = new CallFeed();
  let closed = 0;
  feed.subscribe({ event: () => {}, close: () => (closed += 1) });
  feed.subscribe({ event: () => {}, close: () => (closed += 1) });
  // A subscriber with nothing to close is not an error, and neither is one that throws.
  feed.subscribe({ event: () => {} });
  feed.subscribe({
    event: () => {},
    close: () => {
      throw new Error('already half closed');
    },
  });

  feed.close();
  assert.equal(closed, 2);
  assert.equal(feed.size, 0);

  // And nothing reaches them afterwards.
  feed.publish(event('taken'));
  assert.equal(feed.size, 0);
});
