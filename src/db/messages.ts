import { providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

export type MessageDirection = 'inbound' | 'outbound-api' | 'outbound-reply';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'received' | 'failed';

export interface Message {
  sid: string;
  accountSid: string;
  from: string;
  to: string;
  body: string;
  direction: MessageDirection;
  status: MessageStatus;
  numSegments: number;
  errorCode: number | null;
  /**
   * Where this message's delivery status is reported, named by whoever sent it.
   *
   * **Per message, because that is Twilio's shape.** `StatusCallback` is a parameter on
   * `POST …/Messages.json`, not a setting on a number — and the callback is the sender's,
   * describing their own outbound message, so it is signed with the *sender's* auth token.
   */
  statusCallbackUrl: string | null;
  /** Echoed back on the resource. Only set when the placement actually named one. */
  messagingServiceSid: string | null;
  createdAt: number;
}

interface Row {
  sid: string;
  account_sid: string;
  from_number: string;
  to_number: string;
  body: string;
  direction: string;
  status: string;
  num_segments: number;
  error_code: number | null;
  status_callback_url: string | null;
  messaging_service_sid: string | null;
  created_at: number;
}

function hydrate(row: Row): Message {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    from: row.from_number,
    to: row.to_number,
    body: row.body,
    direction: row.direction as MessageDirection,
    status: row.status as MessageStatus,
    numSegments: row.num_segments,
    errorCode: row.error_code,
    statusCallbackUrl: row.status_callback_url,
    messagingServiceSid: row.messaging_service_sid,
    createdAt: row.created_at,
  };
}

/**
 * Twilio's own arithmetic: 160 characters a segment while the body stays inside GSM-7,
 * and 70 the moment anything is not. Approximated by an ASCII test, which is the same
 * answer for every body a developer will type and is wrong only for the handful of
 * characters GSM-7 has that ASCII does not.
 */
export function segmentCount(body: string): number {
  const size = /^[\x00-\x7f]*$/.test(body) ? 160 : 70;
  return Math.max(1, Math.ceil(body.length / size));
}

/**
 * Every message this simulator has carried, in both directions, between any two numbers.
 *
 * **The `SM…` is minted here and nowhere else**, which is the invariant that keeps the
 * sid answered to a `POST …/Messages.json` and the sid in the thread one value — that sid
 * is what the application under test stores as its own message id, and a second mint in
 * the route would leave the record and the answer as two messages that merely look alike.
 *
 * Three directions rather than Twilio's two: `outbound-reply` is a `<Message>` that came
 * back in a messaging webhook's own TwiML, which Twilio does not distinguish but which is
 * worth being able to see — it is the reply that never went near the REST API.
 */
export class Messages {
  constructor(private readonly db: Db) {}

  create(input: {
    accountSid: string;
    from: string;
    to: string;
    body: string;
    direction: MessageDirection;
    status?: MessageStatus;
    sid?: string;
    statusCallbackUrl?: string | null;
    messagingServiceSid?: string | null;
  }): Message {
    const message: Message = {
      sid: input.sid ?? providerId('SM'),
      accountSid: input.accountSid,
      from: input.from,
      to: input.to,
      body: input.body,
      direction: input.direction,
      status: input.status ?? (input.direction === 'inbound' ? 'received' : 'queued'),
      numSegments: segmentCount(input.body),
      errorCode: null,
      statusCallbackUrl: input.statusCallbackUrl ?? null,
      messagingServiceSid: input.messagingServiceSid ?? null,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (
           sid, account_sid, from_number, to_number, body,
           direction, status, num_segments, error_code,
           status_callback_url, messaging_service_sid, created_at
         ) VALUES (
           @sid, @accountSid, @from, @to, @body,
           @direction, @status, @numSegments, @errorCode,
           @statusCallbackUrl, @messagingServiceSid, @createdAt
         )`,
      )
      .run(message);
    return message;
  }

  find(sid: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE sid = ?').get(sid) as
      | Row
      | undefined;
    return row ? hydrate(row) : null;
  }

  setStatus(sid: string, status: MessageStatus, errorCode: number | null = null): Message | null {
    this.db
      .prepare('UPDATE messages SET status = ?, error_code = ? WHERE sid = ?')
      .run(status, errorCode, sid);
    return this.find(sid);
  }

  list(filter: { to?: string; from?: string; limit?: number } = {}): Message[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.to) {
      clauses.push('to_number = ?');
      params.push(filter.to);
    }
    if (filter.from) {
      clauses.push('from_number = ?');
      params.push(filter.from);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(filter.limit ?? 200);
    const rows = this.db
      .prepare(`SELECT * FROM messages ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params) as Row[];
    return rows.map(hydrate);
  }

  /**
   * The conversation between two numbers, oldest first — **both directions**, which is
   * what makes it a thread rather than two lists. The pair is unordered here on purpose:
   * who sent the first message is not what identifies the conversation.
   */
  thread(a: string, b: string, limit = 200): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE (from_number = @a AND to_number = @b) OR (from_number = @b AND to_number = @a)
         ORDER BY created_at ASC, rowid ASC LIMIT @limit`,
      )
      .all({ a, b, limit }) as Row[];
    return rows.map(hydrate);
  }

  /**
   * Every distinct pair that has said anything, newest activity first. The thread picker.
   *
   * `number` narrows it to the conversations one number is part of — the inbox for a single
   * handset — and matches either end for the same reason {@link Calls.list} does.
   *
   * `created_at`, `body` and `from_number` are **bare columns next to a single `MAX()`**,
   * which in SQLite is not arbitrary: they come from the very row that produced that
   * maximum, so they are the newest message's — the preview line.
   *
   * The maximum is over `rowid`, not `created_at`, because `created_at` is only accurate to
   * the second and an auto-replying webhook answers inside the same second as the message
   * that triggered it. Tied maxima let SQLite pick either row, so keying on `created_at`
   * would show the inbound message or its reply at random. `rowid` is unique and ascending,
   * which is also how {@link Messages.list} breaks the same tie.
   *
   * This holds only while that is the **one** min/max aggregate in the query — adding a
   * second one makes the preview silently come from some other row in the group, with no
   * error anywhere.
   */
  threads(
    filter: { number?: string; limit?: number } = {},
  ): Array<{
    a: string;
    b: string;
    lastAt: number;
    count: number;
    lastBody: string;
    lastFrom: string;
  }> {
    const where = filter.number ? 'WHERE from_number = @number OR to_number = @number' : '';
    const rows = this.db
      .prepare(
        `SELECT
           MIN(from_number, to_number) AS a,
           MAX(from_number, to_number) AS b,
           MAX(rowid) AS last_rowid,
           created_at AS last_at,
           COUNT(*) AS n,
           body AS last_body,
           from_number AS last_from
         FROM messages
         ${where}
         GROUP BY a, b
         ORDER BY last_rowid DESC
         LIMIT @limit`,
      )
      // `number` is bound only when the clause that reads it is there: better-sqlite3
      // rejects a named parameter the statement never mentions.
      .all(
        filter.number
          ? { number: filter.number, limit: filter.limit ?? 50 }
          : { limit: filter.limit ?? 50 },
      ) as Array<{
      a: string;
      b: string;
      last_at: number;
      n: number;
      last_body: string;
      last_from: string;
    }>;
    return rows.map((row) => ({
      a: row.a,
      b: row.b,
      lastAt: row.last_at,
      count: row.n,
      lastBody: row.last_body,
      lastFrom: row.last_from,
    }));
  }
}
