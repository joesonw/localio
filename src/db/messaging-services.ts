import { providerId } from '../provider-id.js';
import { now, type Db } from './open.js';
import type { PhoneNumber } from './numbers.js';

export interface MessagingService {
  sid: string;
  accountSid: string;
  friendlyName: string;
  inboundRequestUrl: string | null;
  inboundMethod: string;
  statusCallbackUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  sid: string;
  account_sid: string;
  friendly_name: string;
  inbound_request_url: string | null;
  inbound_method: string;
  status_callback_url: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: Row): MessagingService {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    friendlyName: row.friendly_name,
    inboundRequestUrl: row.inbound_request_url,
    inboundMethod: row.inbound_method,
    statusCallbackUrl: row.status_callback_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The columns of a `phone_numbers` row, as the pool join reads them back. */
interface NumberRow {
  sid: string;
  account_sid: string;
  phone_number: string;
  friendly_name: string;
  voice_url: string | null;
  voice_method: string;
  status_callback_url: string | null;
  status_callback_method: string;
  sms_url: string | null;
  sms_method: string;
  created_at: number;
}

function hydrateNumber(row: NumberRow): PhoneNumber {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    phoneNumber: row.phone_number,
    friendlyName: row.friendly_name,
    voiceUrl: row.voice_url,
    voiceMethod: row.voice_method,
    statusCallbackUrl: row.status_callback_url,
    statusCallbackMethod: row.status_callback_method,
    smsUrl: row.sms_url,
    smsMethod: row.sms_method,
    createdAt: row.created_at,
  };
}

export interface MessagingServiceInput {
  accountSid: string;
  sid?: string;
  friendlyName?: string;
  inboundRequestUrl?: string | null;
  inboundMethod?: string;
  statusCallbackUrl?: string | null;
}

/**
 * Everything a `PATCH` may change.
 *
 * The account is fixed at creation, like an account's parent. A pool that straddled
 * accounts would be delivered with one account's token and read by an application
 * verifying with another's, which is a blanket 403 at the far end with nothing naming why.
 */
export type MessagingServicePatch = Omit<Partial<MessagingServiceInput>, 'sid' | 'accountSid'>;

/**
 * Messaging Services: a pool of numbers that sends as one sender.
 *
 * **A Messaging Service resolves a sender; it never becomes one.** `POST Messages.json`
 * used to read `body.From ?? body.MessagingServiceSid`, which put an `MG…` into the
 * message's `from_number` column — where `findByNumber`, `usage()` and every thread view
 * read it as a phone number and found nothing, with no error raised anywhere. {@link pick}
 * is what that line calls instead.
 *
 * The other half is inbound: a number in a pool whose service carries an
 * `inbound_request_url` answers *there* rather than at its own `sms_url`, which is the
 * point of a pool — one handler for many numbers instead of the same URL pasted onto each.
 * {@link findForNumber} is the lookup `sms.ts` makes on every delivery.
 */
export class MessagingServices {
  constructor(private readonly db: Db) {}

  create(input: MessagingServiceInput): MessagingService {
    const at = now();
    const service: MessagingService = {
      // Pinned sids are accepted for the same reason keys and numbers accept them: an
      // `MG…` already sitting in an application's own configuration can be reproduced
      // here rather than having to be changed over there.
      sid: input.sid ?? providerId('MG'),
      accountSid: input.accountSid,
      friendlyName: input.friendlyName ?? '',
      inboundRequestUrl: input.inboundRequestUrl ?? null,
      inboundMethod: input.inboundMethod ?? 'POST',
      statusCallbackUrl: input.statusCallbackUrl ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO messaging_services
           (sid, account_sid, friendly_name, inbound_request_url, inbound_method,
            status_callback_url, created_at, updated_at)
         VALUES
           (@sid, @accountSid, @friendlyName, @inboundRequestUrl, @inboundMethod,
            @statusCallbackUrl, @createdAt, @updatedAt)`,
      )
      .run(service);
    return service;
  }

  /**
   * Create or update, for the seed.
   *
   * Keyed by the **sid** when the file pins one and by `(account_sid, friendly_name)`
   * otherwise — never by nothing, because a seed is re-applied on every start and a
   * service re-minted each boot would orphan the `MG…` sitting in the application's own
   * configuration. It is the same bargain numbers make by keying on the number.
   */
  upsert(input: MessagingServiceInput): MessagingService {
    const existing = input.sid
      ? this.find(input.sid)
      : this.findByName(input.accountSid, input.friendlyName ?? '');
    if (!existing) return this.create(input);
    return this.update(existing.sid, input) ?? existing;
  }

  find(sid: string): MessagingService | null {
    const row = this.db.prepare('SELECT * FROM messaging_services WHERE sid = ?').get(sid) as
      | Row
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** One account's service by name. What the seed keys on when it pinned no sid. */
  findByName(accountSid: string, friendlyName: string): MessagingService | null {
    const row = this.db
      .prepare('SELECT * FROM messaging_services WHERE account_sid = ? AND friendly_name = ?')
      .get(accountSid, friendlyName) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  list(accountSid?: string): MessagingService[] {
    const rows = (
      accountSid
        ? this.db
            .prepare(
              'SELECT * FROM messaging_services WHERE account_sid = ? ORDER BY created_at ASC',
            )
            .all(accountSid)
        : this.db.prepare('SELECT * FROM messaging_services ORDER BY created_at ASC').all()
    ) as Row[];
    return rows.map(hydrate);
  }

  /**
   * A partial update: every field left out of `patch` keeps the value it had.
   *
   * `undefined` means "not mentioned" and `null` means "clear it", the same distinction
   * `PhoneNumbers.update` draws and for the same reason — an edit that blanked the inbound
   * URL box is asking for `null`, and one that never rendered the box is asking for
   * neither.
   */
  update(sid: string, patch: MessagingServicePatch): MessagingService | null {
    const existing = this.find(sid);
    if (!existing) return null;
    const next: MessagingService = {
      ...existing,
      friendlyName: patch.friendlyName ?? existing.friendlyName,
      inboundRequestUrl:
        patch.inboundRequestUrl === undefined
          ? existing.inboundRequestUrl
          : patch.inboundRequestUrl,
      inboundMethod: patch.inboundMethod ?? existing.inboundMethod,
      statusCallbackUrl:
        patch.statusCallbackUrl === undefined
          ? existing.statusCallbackUrl
          : patch.statusCallbackUrl,
      updatedAt: now(),
    };
    this.db
      .prepare(
        `UPDATE messaging_services SET
           friendly_name = @friendlyName,
           inbound_request_url = @inboundRequestUrl, inbound_method = @inboundMethod,
           status_callback_url = @statusCallbackUrl, updated_at = @updatedAt
         WHERE sid = @sid`,
      )
      .run(next);
    return next;
  }

  /** Remove a service. Its pool rows cascade; the numbers themselves are untouched. */
  remove(sid: string): boolean {
    return this.db.prepare('DELETE FROM messaging_services WHERE sid = ?').run(sid).changes > 0;
  }

  /** Every service of an account, dropped. What deleting the account does. */
  removeForAccount(accountSid: string): number {
    return this.db
      .prepare('DELETE FROM messaging_services WHERE account_sid = ?')
      .run(accountSid).changes;
  }

  /** How many services an account holds. The accounts table in the Admin panel shows this. */
  countFor(accountSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messaging_services WHERE account_sid = ?')
      .get(accountSid) as { n: number };
    return row.n;
  }

  /* --------------------------------------------------------------------- the pool */

  /** The pool, ordered by number so a pinned `rand` in {@link pick} lands on the same row. */
  numbers(serviceSid: string): PhoneNumber[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM phone_numbers p
           JOIN messaging_service_numbers m ON m.number_sid = p.sid
         WHERE m.service_sid = ?
         ORDER BY p.phone_number`,
      )
      .all(serviceSid) as NumberRow[];
    return rows.map(hydrateNumber);
  }

  numberCount(serviceSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM messaging_service_numbers WHERE service_sid = ?')
      .get(serviceSid) as { n: number };
    return row.n;
  }

  /**
   * The service a number is in, or `null`. The lookup every inbound message makes.
   *
   * A single answer rather than a list, which is `UNIQUE (number_sid)`'s doing.
   */
  findForNumber(numberSid: string): MessagingService | null {
    const row = this.db
      .prepare(
        `SELECT s.* FROM messaging_services s
           JOIN messaging_service_numbers m ON m.service_sid = s.sid
         WHERE m.number_sid = ?`,
      )
      .get(numberSid) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /**
   * Put a number in the pool.
   *
   * Three outcomes rather than a boolean, because the two failures are different things to
   * say: `'already'` is this same service and is not an error at all, while `'taken'` is
   * another service holding it and has an `MG…` worth naming in the refusal.
   */
  addNumber(serviceSid: string, numberSid: string): 'added' | 'already' | 'taken' {
    const holder = this.findForNumber(numberSid);
    if (holder) return holder.sid === serviceSid ? 'already' : 'taken';
    this.db
      .prepare(
        `INSERT INTO messaging_service_numbers (service_sid, number_sid, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(serviceSid, numberSid, now());
    return 'added';
  }

  removeNumber(serviceSid: string, numberSid: string): boolean {
    return (
      this.db
        .prepare(
          'DELETE FROM messaging_service_numbers WHERE service_sid = ? AND number_sid = ?',
        )
        .run(serviceSid, numberSid).changes > 0
    );
  }

  /**
   * Which number a `MessagingServiceSid` send goes out from — a random member of the pool.
   *
   * `rand` is a seam, exactly as `nanpNumber`'s is. `ORDER BY RANDOM()` would push the
   * choice down into SQLite where no test can pin it, and "sends from *a* number in the
   * pool" is a property worth asserting rather than observing. `null` is an empty pool,
   * which the route turns into a `21703` — there is no sender to invent.
   */
  pick(serviceSid: string, rand: () => number = Math.random): PhoneNumber | null {
    const pool = this.numbers(serviceSid);
    if (pool.length === 0) return null;
    // Clamped rather than modulo'd: `rand()` is [0, 1) by contract, but a stubbed `() => 1`
    // in a test should pick the last number, not walk off the end.
    return pool[Math.min(Math.floor(rand() * pool.length), pool.length - 1)] ?? null;
  }
}
