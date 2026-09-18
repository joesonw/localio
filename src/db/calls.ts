import { providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

export type CallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled';

export interface Call {
  sid: string;
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound-api';
  status: CallStatus;
  answerUrl: string | null;
  statusCallbackUrl: string | null;
  startTime: number | null;
  endTime: number | null;
  durationSec: number | null;
  createdAt: number;
}

export interface CallEvent {
  id: number;
  callSid: string;
  at: number;
  kind: string;
  detail: unknown;
}

interface Row {
  sid: string;
  account_sid: string;
  from_number: string;
  to_number: string;
  direction: string;
  status: string;
  answer_url: string | null;
  status_callback_url: string | null;
  start_time: number | null;
  end_time: number | null;
  duration_sec: number | null;
  created_at: number;
}

function hydrate(row: Row): Call {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    from: row.from_number,
    to: row.to_number,
    direction: row.direction as Call['direction'],
    status: row.status as CallStatus,
    answerUrl: row.answer_url,
    statusCallbackUrl: row.status_callback_url,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSec: row.duration_sec,
    createdAt: row.created_at,
  };
}

export interface CreateCall {
  accountSid: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound-api';
  status: CallStatus;
  answerUrl?: string | null;
  statusCallbackUrl?: string | null;
  /** Adopt a sid rather than mint one. Used by nothing yet, and deliberately available. */
  sid?: string;
}

/**
 * Every call this simulator has handled, and the log of what happened inside each one.
 *
 * **The `CA…` is minted here and nowhere else.** A `POST …/Calls.json` is answered with a
 * sid out of this store and the row stays behind as the call waiting to be answered — so
 * when the handset picks it up, the sid it adopts is the one the application under test
 * was already told. A second mint on that path would leave the placement and the
 * conversation as two calls that merely look alike, with nothing anywhere saying so.
 *
 * This table also *is* the "placed call registry" the extracted app kept in memory. A
 * queued row is a call ringing; answering takes it, declining cancels it. The difference
 * is that these survive a restart, which a Map did not.
 */
export class Calls {
  constructor(private readonly db: Db) {}

  create(input: CreateCall): Call {
    const call: Call = {
      sid: input.sid ?? providerId('CA'),
      accountSid: input.accountSid,
      from: input.from,
      to: input.to,
      direction: input.direction,
      status: input.status,
      answerUrl: input.answerUrl ?? null,
      statusCallbackUrl: input.statusCallbackUrl ?? null,
      startTime: null,
      endTime: null,
      durationSec: null,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO calls (
           sid, account_sid, from_number, to_number, direction, status,
           answer_url, status_callback_url, start_time, end_time, duration_sec, created_at
         ) VALUES (
           @sid, @accountSid, @from, @to, @direction, @status,
           @answerUrl, @statusCallbackUrl, @startTime, @endTime, @durationSec, @createdAt
         )`,
      )
      .run(call);
    return call;
  }

  find(sid: string): Call | null {
    const row = this.db.prepare('SELECT * FROM calls WHERE sid = ?').get(sid) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Newest first, optionally narrowed.
   *
   * `number` matches **either end** of the call: a number's history is the calls it placed
   * and the calls it took, and a list that showed only one of those would be missing half
   * of what that number did.
   */
  list(filter: { status?: CallStatus; number?: string; limit?: number } = {}): Call[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.number) {
      clauses.push('(from_number = ? OR to_number = ?)');
      params.push(filter.number, filter.number);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT * FROM calls ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(hydrate);
  }

  /**
   * Take a queued call, **once**.
   *
   * The `WHERE status = 'queued'` is the whole of it: two tabs answering the same ringing
   * call would be two voice webhooks and two `<Connect><Stream>`s for one `CallSid`,
   * which is something no provider can produce. `changes === 1` is the one that won.
   */
  answer(sid: string): Call | null {
    const result = this.db
      .prepare(
        `UPDATE calls SET status = 'ringing', start_time = ? WHERE sid = ? AND status = 'queued'`,
      )
      .run(now(), sid);
    return result.changes === 1 ? this.find(sid) : null;
  }

  /** Decline: the entry goes, and **no webhook is posted** — a call nobody picked up never rang. */
  cancel(sid: string): boolean {
    return (
      this.db
        .prepare(`UPDATE calls SET status = 'canceled' WHERE sid = ? AND status = 'queued'`)
        .run(sid).changes === 1
    );
  }

  markInProgress(sid: string): void {
    this.db
      .prepare(`UPDATE calls SET status = 'in-progress', start_time = COALESCE(start_time, ?) WHERE sid = ?`)
      .run(now(), sid);
  }

  /**
   * The call is over. **Idempotent**, because teardown has several entrances — the page
   * hanging up, either socket closing, a `<Hangup>`, a webhook that never answered — and
   * a second finish would be a second status callback for one call.
   */
  finish(sid: string, status: CallStatus): Call | null {
    const call = this.find(sid);
    if (!call) return null;
    if (call.endTime !== null) return call;
    const endTime = now();
    const duration = call.startTime === null ? 0 : Math.max(0, endTime - call.startTime);
    this.db
      .prepare('UPDATE calls SET status = ?, end_time = ?, duration_sec = ? WHERE sid = ?')
      .run(status, endTime, duration, sid);
    return this.find(sid);
  }

  /* ---------------------------------------------------------------- the log */

  log(callSid: string, kind: string, detail: unknown): void {
    this.db
      .prepare('INSERT INTO call_events (call_sid, at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(callSid, now(), kind, JSON.stringify(detail ?? null));
  }

  events(callSid: string): CallEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM call_events WHERE call_sid = ? ORDER BY id ASC')
      .all(callSid) as Array<{
      id: number;
      call_sid: string;
      at: number;
      kind: string;
      detail: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      callSid: row.call_sid,
      at: row.at,
      kind: row.kind,
      // A row written by an older version, or by hand, must not take the history page
      // down — the log is for reading after something went wrong.
      detail: safeParse(row.detail),
    }));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
