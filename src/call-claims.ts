/**
 * Who is *currently trying* to pick a waiting call up.
 *
 * **This is not the registry of waiting calls and it is not what makes answering
 * once-only.** The registry is the `calls` table, and the guarantee is the conditional
 * UPDATE in `Calls.answer()` — `WHERE status = 'queued'`, atomic, and it survives a
 * restart. Nothing here may ever be made load-bearing in its place.
 *
 * What this fixes is a window. Answering runs when the `dial` frame reaches the server,
 * which is *after* the page has opened a socket and prompted for the microphone. Without
 * a claim, two tabs both click Pick up, both walk through that prompt, and the loser only
 * finds out seconds later. A claim taken on the click lets every other tab grey the row
 * out on its next poll instead.
 *
 * So a claim is advisory and expires. The TTL is the backstop for the tab that claimed
 * and then died: nobody is coming back to release it, and a call nobody can answer is
 * worse than a call two tabs briefly raced for. Expiry is swept on read rather than on a
 * timer — there is no handle to unref, and `now` is injectable, which is what makes
 * `call-claims.test.ts` hermetic.
 */

interface Claim {
  holder: string;
  expiresAt: number;
}

/** Long enough to answer a microphone prompt, short enough that a dead tab is not a wall. */
const DEFAULT_TTL_MS = 15_000;

export class CallClaims {
  private readonly claims = new Map<string, Claim>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take the claim, or renew one already held.
   *
   * The same holder claiming twice is a success, not a conflict: a page that retries after
   * a dropped socket is the same person still trying to pick up the same call.
   */
  claim(sid: string, holder: string): boolean {
    const held = this.heldBy(sid);
    if (held !== null && held !== holder) return false;
    this.claims.set(sid, { holder, expiresAt: this.now() + this.ttlMs });
    return true;
  }

  /** The live holder, or `null` — an expired claim is dropped here rather than reported. */
  heldBy(sid: string): string | null {
    const claim = this.claims.get(sid);
    if (claim === undefined) return null;
    if (claim.expiresAt <= this.now()) {
      this.claims.delete(sid);
      return null;
    }
    return claim.holder;
  }

  /** When the current claim lapses, or `null` if there is none. */
  expiresAt(sid: string): number | null {
    return this.heldBy(sid) === null ? null : (this.claims.get(sid)?.expiresAt ?? null);
  }

  /**
   * Give it up.
   *
   * Passing a `holder` that does not match is a **no-op, not an error**: it means the
   * claim already lapsed and somebody else has it, and stealing it back would be the one
   * thing this class must never do. Omitting `holder` releases unconditionally, which is
   * what declining a call does — the call is gone, so there is nothing left to hold.
   */
  release(sid: string, holder?: string): void {
    if (holder !== undefined && this.claims.get(sid)?.holder !== holder) return;
    this.claims.delete(sid);
  }
}
