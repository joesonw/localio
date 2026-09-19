-- localio, migration 5. Messaging Services: many numbers that send as one sender.
--
-- Twilio's messaging.twilio.com `Service` is two things at once and both are here: a
-- **sender pool**, so a `POST Messages.json` naming a `MessagingServiceSid` and no `From`
-- picks a number out of it, and a **shared inbound handler**, so every number in the pool
-- answers at one URL instead of at its own `sms_url`. `messages.messaging_service_sid`
-- (migration 4) already stored the sid; this is what makes it resolve to something.

CREATE TABLE messaging_services (
  sid TEXT PRIMARY KEY,                 -- MG + 32 hex
  account_sid TEXT NOT NULL REFERENCES accounts(account_sid),
  friendly_name TEXT NOT NULL DEFAULT '',
  -- Where an inbound message to *any* number in the pool is posted, and the URL its
  -- signature is computed over -- one column, for the same reason `phone_numbers` keeps
  -- one. NULL means the pool changes nothing about inbound: each number keeps answering
  -- at its own `sms_url`, so joining a pool never silently moves a number's traffic.
  inbound_request_url TEXT,
  inbound_method TEXT NOT NULL DEFAULT 'POST',
  -- The fallback for a send that named no `StatusCallback` of its own. Read in the
  -- Messages route, never here -- a column nothing reads is what migration 4 existed to
  -- delete.
  status_callback_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The pool.
--
-- **`ON DELETE CASCADE` on both sides is load-bearing.** `foreign_keys = ON`, and
-- `PhoneNumbers.remove()` is a bare DELETE that has never heard of services: without the
-- cascade, releasing a pooled number fails as an opaque `SQLITE_CONSTRAINT` out of a
-- method nothing about this feature touched. Deleting a service likewise empties its pool
-- and leaves every number exactly as it was.
--
-- **`UNIQUE (number_sid)`** is Twilio's own rule -- a number is in at most one Messaging
-- Service -- and it is also what makes `findForNumber` a single answer rather than an
-- arbitrary pick among several, which is what inbound resolution needs.
CREATE TABLE messaging_service_numbers (
  service_sid TEXT NOT NULL REFERENCES messaging_services(sid) ON DELETE CASCADE,
  number_sid TEXT NOT NULL UNIQUE REFERENCES phone_numbers(sid) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (service_sid, number_sid)
);

CREATE INDEX messaging_services_account ON messaging_services(account_sid);
