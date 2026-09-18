-- localio, migration 1. Everything this simulator remembers.
--
-- Five tables and one log. `accounts` and `phone_numbers` are configuration — what this
-- simulator *is*; `calls`, `call_events`, `recordings` and `messages` are history — what
-- it has *done*. The split matters when a number is deleted: the history rows carry the
-- numbers as text rather than as a foreign key, so removing a number never removes the
-- record of what happened on it.

CREATE TABLE accounts (
  account_sid   TEXT PRIMARY KEY,          -- AC + 32 hex
  auth_token    TEXT NOT NULL,             -- what every webhook from this account is signed with
  friendly_name TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);

CREATE TABLE phone_numbers (
  sid                     TEXT PRIMARY KEY,   -- PN + 32 hex
  account_sid             TEXT NOT NULL REFERENCES accounts(account_sid),
  phone_number            TEXT NOT NULL UNIQUE,  -- E.164
  friendly_name           TEXT NOT NULL DEFAULT '',
  -- A number's own webhook URLs, exactly as at Twilio. These are both the URL a webhook
  -- is POSTed to and the URL its signature is computed over: one string, so the two can
  -- never drift apart.
  voice_url               TEXT,
  voice_method            TEXT NOT NULL DEFAULT 'POST',
  status_callback_url     TEXT,
  status_callback_method  TEXT NOT NULL DEFAULT 'POST',
  sms_url                 TEXT,
  sms_method              TEXT NOT NULL DEFAULT 'POST',
  sms_status_callback_url TEXT,
  created_at              INTEGER NOT NULL
);

CREATE TABLE calls (
  sid                 TEXT PRIMARY KEY,   -- CA + 32 hex
  account_sid         TEXT NOT NULL,
  from_number         TEXT NOT NULL,
  to_number           TEXT NOT NULL,
  direction           TEXT NOT NULL,      -- inbound | outbound-api
  -- queued | ringing | in-progress | completed | busy | no-answer | failed | canceled
  status              TEXT NOT NULL,
  -- The `Url` a REST placement named. A call the handset dialled in has none and uses
  -- the number's own `voice_url`; a placed call is answered at the URL that placed it,
  -- which is what carries the application's own routing (an agent id, a job id) into it.
  answer_url          TEXT,
  status_callback_url TEXT,
  start_time          INTEGER,
  end_time            INTEGER,
  duration_sec        INTEGER,
  created_at          INTEGER NOT NULL
);

-- The event log. In the app this was extracted from this lived only in a browser tab and
-- was gone the moment it was closed; here it outlives the call, which is what makes
-- "why did that call end that way" answerable after the fact.
CREATE TABLE call_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT NOT NULL REFERENCES calls(sid),
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,   -- webhook | twiml | verb | stream | dtmf | recording | error | end
  detail   TEXT NOT NULL    -- JSON
);

CREATE TABLE recordings (
  sid          TEXT PRIMARY KEY,   -- RE + 32 hex
  call_sid     TEXT NOT NULL REFERENCES calls(sid),
  account_sid  TEXT NOT NULL,
  path         TEXT NOT NULL,      -- an absolute path to a 16-bit PCM, 8 kHz, mono WAV
  duration_sec INTEGER NOT NULL,
  channels     INTEGER NOT NULL DEFAULT 1,
  source       TEXT NOT NULL DEFAULT 'RecordVerb',
  status       TEXT NOT NULL DEFAULT 'completed',
  created_at   INTEGER NOT NULL
);

CREATE TABLE messages (
  sid          TEXT PRIMARY KEY,   -- SM + 32 hex
  account_sid  TEXT NOT NULL,
  from_number  TEXT NOT NULL,
  to_number    TEXT NOT NULL,
  body         TEXT NOT NULL,
  direction    TEXT NOT NULL,      -- inbound | outbound-api | outbound-reply
  status       TEXT NOT NULL,      -- queued | sent | delivered | received | failed
  num_segments INTEGER NOT NULL DEFAULT 1,
  error_code   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX calls_created     ON calls(created_at DESC);
CREATE INDEX calls_status      ON calls(status, created_at DESC);
CREATE INDEX call_events_call  ON call_events(call_sid, id);
CREATE INDEX messages_created  ON messages(created_at DESC);
CREATE INDEX messages_pair     ON messages(from_number, to_number, created_at DESC);
CREATE INDEX recordings_call   ON recordings(call_sid, created_at DESC);
CREATE INDEX numbers_account   ON phone_numbers(account_sid);
