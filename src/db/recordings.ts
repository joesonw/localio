import { providerId } from '../provider-id.js';
import { now, type Db } from './open.js';

export interface Recording {
  sid: string;
  callSid: string;
  accountSid: string;
  path: string;
  durationSec: number;
  channels: number;
  source: string;
  status: string;
  createdAt: number;
}

interface Row {
  sid: string;
  call_sid: string;
  account_sid: string;
  path: string;
  duration_sec: number;
  channels: number;
  source: string;
  status: string;
  created_at: number;
}

function hydrate(row: Row): Recording {
  return {
    sid: row.sid,
    callSid: row.call_sid,
    accountSid: row.account_sid,
    path: row.path,
    durationSec: row.duration_sec,
    channels: row.channels,
    source: row.source,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * What `<Record>` produced.
 *
 * The audio is a file on disk and the row holds a path to it; the row is what a
 * `RecordingUrl` resolves through. `RE…` is minted here for the reason every other sid
 * is: the sid in the `action` callback and the sid in the list have to be one value, or
 * the application under test fetches a recording that does not exist.
 */
export class Recordings {
  constructor(private readonly db: Db) {}

  /** The sid is minted before the audio is written, so the file can be named after it. */
  mint(): string {
    return providerId('RE');
  }

  create(input: {
    sid: string;
    callSid: string;
    accountSid: string;
    path: string;
    durationSec: number;
    channels?: number;
    source?: string;
  }): Recording {
    const recording: Recording = {
      sid: input.sid,
      callSid: input.callSid,
      accountSid: input.accountSid,
      path: input.path,
      durationSec: input.durationSec,
      channels: input.channels ?? 1,
      source: input.source ?? 'RecordVerb',
      status: 'completed',
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO recordings (
           sid, call_sid, account_sid, path, duration_sec, channels, source, status, created_at
         ) VALUES (
           @sid, @callSid, @accountSid, @path, @durationSec, @channels, @source, @status, @createdAt
         )`,
      )
      .run(recording);
    return recording;
  }

  find(sid: string): Recording | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE sid = ?').get(sid) as
      | Row
      | undefined;
    return row ? hydrate(row) : null;
  }

  list(filter: { callSid?: string; limit?: number } = {}): Recording[] {
    const rows = (
      filter.callSid
        ? this.db
            .prepare('SELECT * FROM recordings WHERE call_sid = ? ORDER BY created_at DESC LIMIT ?')
            .all(filter.callSid, filter.limit ?? 100)
        : this.db
            .prepare('SELECT * FROM recordings ORDER BY created_at DESC LIMIT ?')
            .all(filter.limit ?? 100)
    ) as Row[];
    return rows.map(hydrate);
  }

  remove(sid: string): boolean {
    return this.db.prepare('DELETE FROM recordings WHERE sid = ?').run(sid).changes > 0;
  }
}
