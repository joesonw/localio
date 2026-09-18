import type { Call } from './db/index.js';

/**
 * Who is waiting to hear that a pending call changed.
 *
 * **This is not the registry of waiting calls and it is not what makes answering
 * once-only.** The registry is the `calls` table; the guarantee is the conditional UPDATE
 * in `Calls.answer()`. This is a third advisory layer, above the claim, whose only job is
 * to shorten a wait: without it the Phone panel learns about a new call, and about one
 * somebody else is picking up, on the next tick of a two-second poll. Nothing here may
 * ever be made load-bearing, and the poll stays — it is what heals a stream that dropped a
 * frame or never connected.
 *
 * In-process and synchronous on purpose. There is one server object, the subscribers are
 * open SSE responses on it, and a fan-out that needed a broker would be a different
 * program. No clock and no timers, which is what makes `call-feed.test.ts` hermetic.
 */

export type CallFeedKind = 'ringing' | 'claimed' | 'released' | 'taken' | 'declined';

export interface CallFeedEvent {
  kind: CallFeedKind;
  /** The row as it stands *after* the transition — never a prediction of one. */
  call: Call;
  /** `claims.heldBy(sid)` at publish time, so a subscriber needs no second lookup. */
  claimedBy: string | null;
}

export interface CallFeedSubscriber {
  /** One transition. */
  event: (event: CallFeedEvent) => void;
  /**
   * The server is going away and this subscription will get nothing more.
   *
   * An SSE response has to be *ended* here, not merely forgotten: Fastify's `close()`
   * waits on open connections, so a stream left hanging is a process that will not exit.
   */
  close?: () => void;
}

export class CallFeed {
  private readonly subscribers = new Set<CallFeedSubscriber>();

  /** Listen, and get the way to stop back. Unsubscribing twice is a no-op. */
  subscribe(subscriber: CallFeedSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * Tell everyone.
   *
   * Over a copy of the set, because a subscriber may unsubscribe itself from inside its
   * own handler — an SSE response whose socket has just gone does exactly that. One that
   * throws must not cost the others their event either: this feed is the reason a second
   * tab greys out in time, and one broken subscriber taking the rest down would hand that
   * window straight back.
   */
  publish(event: CallFeedEvent): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.event(event);
      } catch {
        // Nothing useful to do with it here. The subscriber is a response writer; if its
        // socket is gone it is already on its way out via its own `close` handler.
      }
    }
  }

  /**
   * Let everyone go, and say so.
   *
   * Called from `LocalioServer.close()` **before** `app.close()`. An SSE response never
   * ends on its own and Fastify's close waits on open connections, so without this the
   * process hangs on Ctrl-C with nothing anywhere saying why.
   */
  close(): void {
    for (const subscriber of [...this.subscribers]) {
      this.subscribers.delete(subscriber);
      try {
        subscriber.close?.();
      } catch {
        // Shutting down. A subscriber that cannot be closed cleanly is not worth failing
        // the shutdown over — the socket goes with the server either way.
      }
    }
  }

  /** How many streams are open. Reported by `/api/settings`; otherwise for tests. */
  get size(): number {
    return this.subscribers.size;
  }
}
