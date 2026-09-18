import { authToken, providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

export interface ApiKey {
  sid: string;
  accountSid: string;
  secret: string;
  friendlyName: string;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  sid: string;
  account_sid: string;
  secret: string;
  friendly_name: string;
  created_at: number;
  updated_at: number;
}

function hydrate(row: Row): ApiKey {
  return {
    sid: row.sid,
    accountSid: row.account_sid,
    secret: row.secret,
    friendlyName: row.friendly_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * API keys: a second credential that opens an account.
 *
 * A Twilio client built as `twilio(keySid, keySecret, { accountSid })` sends `SK…` as the
 * Basic username and the secret as the password, and that is the whole of what this is
 * for. **A key authenticates; it never signs.** Every webhook out of here is signed with
 * the *account's* `auth_token` — see `signature.ts` — because that is what the
 * application under test verifies with, and a key that quietly changed the signing secret
 * would produce a blanket 403 at the far end with nothing naming the cause.
 *
 * The sid and the secret are minted here and nowhere else, the same rule `Accounts` holds
 * for `AC…`.
 */
export class ApiKeys {
  constructor(private readonly db: Db) {}

  create(input: {
    accountSid: string;
    friendlyName?: string;
    sid?: string;
    secret?: string;
  }): ApiKey {
    const at = now();
    const key: ApiKey = {
      // Pinned sid and secret are accepted so a key an application already has in its own
      // configuration can be reproduced here; left out, both are minted.
      sid: input.sid ?? providerId('SK'),
      accountSid: input.accountSid,
      secret: input.secret ?? authToken(),
      friendlyName: input.friendlyName ?? '',
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO api_keys (sid, account_sid, secret, friendly_name, created_at, updated_at)
         VALUES (@sid, @accountSid, @secret, @friendlyName, @createdAt, @updatedAt)`,
      )
      .run(key);
    return key;
  }

  find(sid: string): ApiKey | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE sid = ?').get(sid) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /** Every key, or one account's. */
  list(accountSid?: string): ApiKey[] {
    const rows = (
      accountSid === undefined
        ? this.db.prepare('SELECT * FROM api_keys ORDER BY created_at ASC').all()
        : this.db
            .prepare('SELECT * FROM api_keys WHERE account_sid = ? ORDER BY created_at ASC')
            .all(accountSid)
    ) as Row[];
    return rows.map(hydrate);
  }

  /**
   * The friendly name, and nothing else.
   *
   * Twilio's own `POST Keys/:sid.json` updates the name alone: the secret is not
   * rotatable and the account a key belongs to is not movable.
   */
  update(sid: string, patch: { friendlyName?: string }): ApiKey | null {
    const existing = this.find(sid);
    if (!existing) return null;
    const next: ApiKey = {
      ...existing,
      friendlyName: patch.friendlyName ?? existing.friendlyName,
      updatedAt: now(),
    };
    this.db
      .prepare(
        'UPDATE api_keys SET friendly_name = @friendlyName, updated_at = @updatedAt WHERE sid = @sid',
      )
      .run(next);
    return next;
  }

  remove(sid: string): 'deleted' | 'not-found' {
    if (!this.find(sid)) return 'not-found';
    this.db.prepare('DELETE FROM api_keys WHERE sid = ?').run(sid);
    return 'deleted';
  }

  /** How many keys an account holds. The accounts table in the Admin panel shows this. */
  countFor(accountSid: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE account_sid = ?')
      .get(accountSid) as { n: number };
    return row.n;
  }

  /** Every key of an account, dropped. What deleting the account does. */
  removeForAccount(accountSid: string): number {
    return this.db.prepare('DELETE FROM api_keys WHERE account_sid = ?').run(accountSid).changes;
  }
}
