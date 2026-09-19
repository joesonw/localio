-- localio, migration 4. Twilio fidelity: per-message status callbacks, and the call
-- parameters `POST Calls.json` used to drop on the floor.
--
-- The headline is that a message status callback is **per message**, not per number.
-- Twilio takes `StatusCallback` on `POST …/Messages.json` and posts delivery status to
-- *that* URL, signed with the *sender's* auth token. The column this replaces lived on
-- `phone_numbers` and was read off the **destination**, so the one party that never asked
-- for a callback was the one receiving it — and it was signed with the wrong account's
-- token, which the Twilio SDK's validator rejects with nothing naming why.
ALTER TABLE messages ADD COLUMN status_callback_url TEXT;

-- Echoed back as `messaging_service_sid` on the message resource. Stored rather than
-- recomputed because the request either named one or it did not, and a later read cannot
-- tell the difference from `from` alone.
ALTER TABLE messages ADD COLUMN messaging_service_sid TEXT;

-- Twilio accepts inline TwiML on a call placement instead of a `Url`, and applications
-- under test use it constantly. Mutually exclusive with `answer_url` in practice; the
-- executor is handed whichever is present.
ALTER TABLE calls ADD COLUMN answer_twiml TEXT;

-- `Method` and `StatusCallbackMethod` from the placement. These used to be read off the
-- *number* row, which is wrong for a placed call: its `From` may be a number this
-- simulator does not hold, in which case there was no row to read and POST was assumed.
ALTER TABLE calls ADD COLUMN answer_method TEXT NOT NULL DEFAULT 'POST';
ALTER TABLE calls ADD COLUMN status_callback_method TEXT NOT NULL DEFAULT 'POST';

-- The `StatusCallbackEvent` list, JSON-encoded. NULL means the caller named none, which
-- Twilio reads as `completed` only — the default is resolved on read rather than written
-- here, so a row cannot disagree with the version of that default the code believes in.
ALTER TABLE calls ADD COLUMN status_callback_events TEXT;

-- `SequenceNumber` on a call-progress callback, 0-based and monotonic per call. It lives
-- on the row rather than in the session because the first event (`initiated`) is posted
-- from the REST route, before any session exists, and the rest are posted from the
-- session. Two counters would number them twice.
ALTER TABLE calls ADD COLUMN callback_seq INTEGER NOT NULL DEFAULT 0;

-- The field this migration exists to remove. Twilio's `IncomingPhoneNumber` has `sms_url`
-- for inbound messages and `status_callback` for voice; it has no SMS status callback at
-- all. Dropped rather than left unread, so there is no second place a future reader could
-- mistake for the answer.
ALTER TABLE phone_numbers DROP COLUMN sms_status_callback_url;
