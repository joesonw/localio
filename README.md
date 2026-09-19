# localio

A local Twilio. Voice, SMS and recordings, on SQLite, in one process.

Point your application's Twilio base URL at it and it answers the REST API. Give one of
its numbers your webhook URL and it posts signed webhooks at you, reads the TwiML you
answer with, and runs it — including `<Record>`, which writes a real WAV you can play back.
A browser tab is the handset.

No Twilio account, no real number, no tunnel.

```
browser tab                      localio                        your application

  mic ──PCM16 8k binary──▶ ┌──────────────┐ ──signed form POST──▶ voice webhook
                           │              │ ◀────── TwiML ───────
  spk ◀─PCM16 8k binary─── │  one call    │
                           │              │ ──ws + twilio JSON──▶ your media stream
  keypad ──dtmf JSON─────▶ │  µ-law codec │ ◀── media / mark / clear ──
                           │              │
                           │  <Record>    │ ──▶ data/recordings/RE….wav
                           │              │ ──signed action POST─▶ your handler
                           └──────────────┘ ──signed status POST─▶ status webhook
```

## Running it

```bash
npx @joesonw/localio   # http://127.0.0.1:8080
```

npm 12 blocks dependency install scripts unless the *installing* project allows them, and
`better-sqlite3` needs its one to build the native binding. On npm >= 12:

```bash
npx --allow-scripts=better-sqlite3 @joesonw/localio
# or once, for good: npm config set allow-scripts=better-sqlite3 --location=user
```

Or from a clone, which is also how you get `--watch` on the sources:

```bash
npm install
npm run dev            # http://127.0.0.1:8080
```

Open <http://127.0.0.1:8080>, create an account in the **Admin** panel, add a number, and
point its webhook URLs at your application. Then point your application at localio:

```js
const client = twilio(accountSid, authToken);
client.api.baseUrl = 'http://127.0.0.1:8080';
```

That one assignment redirects the SDK's whole `api` domain — calls, messages, provisioning
and recordings all land here.

To skip the clicking, put the same thing in a seed file (`seed.example.json` is a template)
and pass `--seed` (or set `SEED`). It is applied on every boot, upserting, so it is safe to check in.

### In Docker

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v localio-data:/data joesonw/localio
```

The image binds `0.0.0.0` because loopback inside a container is nobody's address — so
publish the port to `127.0.0.1` as above and it is as reachable as `npm run dev` was, and
no more. It will still warn on boot that nothing here is authenticated; that warning is
right.

The volume at `/data` holds the database and the recordings (`DB` and `RECORDINGS_DIR`
already point there). A seed is a file you mount:

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  -v localio-data:/data \
  -v "$PWD/seed.example.json:/seed.json:ro" \
  joesonw/localio node dist/index.js --seed /seed.json
```

Every flag and variable in [Configuration](#configuration) works the same way — `-e
PORT=…` for the standing arrangement, a flag after the image name for the one-off.
Remember that `PUBLIC_URL` is this server's address *as your application sees it*, which
from inside a container is rarely the default: set it when recordings come back with a
URL your application cannot fetch.

Images are published on every tag (`joesonw/localio:1.2.3`, `:1.2`, `:1`, `:latest`) and
on `main` (`:main`), for `linux/amd64` and `linux/arm64`.

## The two panels

| panel | what it does |
| --- | --- |
| **Phone** | one of your numbers, as a handset. Calls waiting to be picked up sit across the top; pick a number under them and everything below is its own: its calls on the left, the keypad in the middle, its conversations on the right. |
| **Admin** | accounts, API keys, phone numbers and messaging services. Create an account to get a sid and token, name a parent to make it a subaccount, mint a key if the application under test is built with one, add numbers and edit their webhook URLs in place, and pool numbers into a messaging service. Subaccounts sit indented under their parent, with a status you can suspend from here. This is the only configuration there is. |

![The Phone panel — picker, calls, keypad and conversations](https://raw.githubusercontent.com/joesonw/localio/main/docs/preview1.jpg)

*The Phone panel: one number, its calls, its keypad, its conversations.*

![The Admin panel — accounts, API keys and phone numbers](https://raw.githubusercontent.com/joesonw/localio/main/docs/preview2.jpg)

*The Admin panel: accounts and subaccounts, API keys, and numbers with their webhook URLs.*

### The Phone panel

The picker near the top is the whole page's subject — think of it as which SIM is in the
handset. It searches as you type, and it is remembered between restarts.

Above it, and the one thing on this panel that is deliberately **not** the picker's number,
is the strip of calls waiting to be picked up — one line each, both numbers on it, **Pick
up** and **Decline**. A call your application placed went out on whichever of your numbers
it named, and having to already be on that number before the page would show it is how you
end up waiting for something that is on screen nowhere. Picking one up moves the picker to
that call's number, which is what brings the columns below back in step.

That strip is pushed rather than polled — `GET /api/calls/stream`, below — so a call your
application just placed appears at once, and a call another tab is picking up greys out
there before that tab has finished asking for its microphone.

- **Calls** — every call this number made or took, newest first, with a status pill, the
  duration, an inline **▶** for anything `<Record>` captured (one player for the page, so
  starting a second recording stops the first) and an `events` toggle for the call's own log.
- **Keypad** — the number you type is the one calling **in**: the handset only ever dials in,
  so a call from here is somebody ringing the number in the picker. With a call up the same
  keys send DTMF instead of composing. A call your application placed through `Calls.json`
  is picked up from the strip at the top instead, and picking it up keeps the `CA…` your
  application was already told.
- **Messages** — a conversation per number with a preview of the last thing said, newest
  first. Click one to open it; sending from there arrives as if from outside, so a `<Message>`
  reply from your webhook lands in the same thread.

## What happens when you dial

1. A `CallSid` is minted in Twilio's shape, and the number decides the rest: whichever end
   of the call is one of yours names the `phone_numbers` row, and that row names the
   account and the auth token the webhook is signed with.
2. A form-urlencoded voice webhook is signed and posted to the number's `voice_url`.
   **The URL signed and the URL posted to are the same string**, so they cannot disagree.
3. The TwiML is read and **executed**, verb by verb.
4. Hanging up posts the **status callback** — the webhook nothing but a real provider
   exercises.

## The TwiML it runs

| verb | what it does |
| --- | --- |
| `<Say>` | there is no TTS. The text is shown in the event log and the line is held for about as long as saying it would take. |
| `<Play>` | fetches the URL and plays it to the handset. WAV only — 8-bit PCM, 16-bit PCM or µ-law, mono or stereo, any rate. MP3 is reported, not decoded. |
| `<Pause>` | waits. |
| `<Record>` | records the caller and writes `data/recordings/RE….wav`. Honours `maxLength`, `timeout`, `finishOnKey`, `playBeep`, `trim`, `recordingStatusCallback` and `action`. |
| `<Redirect>` | fetches the next document and continues in it. |
| `<Reject>` | ends the call as `busy` or `no-answer`, and **posts the status callback** carrying that status, as Twilio does. |
| `<Hangup>` | ends the call and posts the status callback. |
| `<Connect><Stream>` | opens the Media Streams socket, relays the `<Parameter>` children verbatim into the `start` frame, and bridges the browser's PCM16 to µ-law. |
| `<Message>` | sends an SMS, delivered the same way `POST Messages.json` delivers one. In a messaging webhook's answer, this is the reply. |
| anything else | logged as unsupported and **skipped**. `<Gather>` and `<Dial>` take this path. |

## `<Record>`

While the verb is running, the caller's audio is buffered. It stops at the first of —
`maxLength` reached, a `finishOnKey` digit, `timeout` seconds of silence, or the call
ending — and which one it was is reported: a key comes back as `Digits`, a hangup as the
literal `hangup`, exactly as at Twilio.

Then a 16-bit PCM, 8 kHz, mono WAV is written, a row is inserted, and:

- `recordingStatusCallback`, if set, gets a signed POST with `RecordingSid`,
  `RecordingUrl`, `RecordingDuration` and `RecordingStatus=completed`;
- `action`, if set, gets a signed POST with the same plus `Digits`, **and the call
  continues with whatever TwiML comes back** — which is what makes a record-and-review loop
  expressible.

`RecordingUrl` is `${PUBLIC_URL}/2010-04-01/Accounts/AC…/Recordings/RE…`, and it is
served as `audio/wav` without credentials, the way Twilio's own media URL is.
**`.mp3` answers 501** rather than serving a WAV under a name that will not decode.

## SMS between two numbers

A message reaches localio either from your application (`POST …/Messages.json`) or from the
Phone panel's messages column. **Text**, next to Call on the keypad, starts a conversation
with whatever number is in the dial box — the messaging counterpart of dialling in, and the
only way to be a number that has never texted you before. If the destination is a number
localio holds and it has an `sms_url`, the message is **delivered**: a signed inbound
messaging webhook goes to that URL, and any `<Message>` in the TwiML that comes back is
stored as a reply and delivered in turn. Two local numbers can hold a whole conversation
with no Twilio anywhere.

If the destination is a number localio does not hold, the message is stored as outbound and
left. Nobody is on the other end, which is what that means.

A reply chain stops after five hops, because two auto-replying numbers pointed at each
other is the first thing anybody tries.

**Delivery status is reported per message, to the sender.** Name a `StatusCallback` on
`POST …/Messages.json` and localio posts that message's final status to it, signed with
your account's auth token — `MessageSid`, `MessageStatus` and `SmsStatus`, plus `ErrorCode`
when there is one. This is Twilio's shape: there is no SMS status callback on a number.
An `IncomingPhoneNumber` has `sms_url` for inbound messages and `status_callback` for
voice, and nothing at all for delivery status.

Every outcome is reported, which is the point — a message to a number localio does not hold
comes back `sent`, one to a held number with no `sms_url` comes back `delivered`, and a
webhook that refuses comes back `failed` with `ErrorCode=30003`. A `<Message>` reply is its
own message and does not inherit the callback of the message that prompted it.

### Messaging Services

A **messaging service** is a pool of your numbers that sends as one sender. Send with its
`MessagingServiceSid` and no `From` and localio picks a number out of the pool at random,
which is the behaviour an application testing a sender pool is actually looking for; the
sid is echoed back on the message either way. A `From` you name yourself still wins. A
service whose pool is empty has no sender to invent, so it answers `21703` rather than
sending from nothing, and a service belonging to another account is a `20404` like any
other sid across that boundary.

The other half is inbound. Give the service an `inbound_request_url` and **every number in
the pool answers there** instead of at its own `sms_url` — one handler for many numbers,
which is the point of a pool — and the webhook carries `MessagingServiceSid` so your
routing can tell one pool from another. Leave it blank and joining a pool changes nothing
about inbound: a number keeps answering where it did. A service may also carry a
`StatusCallback`, used for any message sent through it that named none of its own.

A pool is one account's, and a number is in at most one service — both are Twilio's rules,
and the first is also what lets localio sign a pooled delivery with a single auth token.
Releasing a number takes it out of its pool; deleting a service leaves every number, and
its URLs, exactly as they were.

## The routes

### `/2010-04-01` — the Twilio REST API

Under `/2010-04-01`, behind HTTP Basic verified against the `accounts` table: the username
is the `:sid` in the path, the password is that account's auth token. **An API key works
too** — the username is an `SK…` of that account and the password its secret, which is
what a client built as `twilio(keySid, keySecret, { accountSid })` sends. Either way the
webhooks localio posts are signed with the *account's* auth token: a key opens the API, it
never signs.

**A parent's credentials also open its subaccounts**, which is what a client built as
`twilio(parentSid, parentToken, { accountSid: subSid })` sends. The resource stays the
subaccount's either way — a call placed that way is the child's call, with the child's sid
on it, signed with the child's token. It runs one way only: a child's credentials do not
open its parent, and two children of one parent are strangers. A subaccount whose `status`
is not `active` is refused with a `20005`.

Paths below are relative to `/2010-04-01/Accounts/:sid`, except the two `Accounts` routes
at the top, which are absolute.

**A sid names a resource of the account in the path, or nothing.** Every `:sid` route
answers `20404` for a row another account holds — not `403`, which would confirm it
exists. Lists carry Twilio's full envelope (`first_page_uri`, `next_page_uri`, `start`,
`end`), so the SDK's auto-pagination walks every page rather than stopping after one.

| | |
| --- | --- |
| `POST GET /2010-04-01/Accounts.json` | create a **subaccount**, and list yourself plus your subaccounts. `FriendlyName` and `Status` narrow the list. A subaccount cannot hold subaccounts — one level, as at Twilio. |
| `GET POST /2010-04-01/Accounts/:sid.json` | fetch, rename, or change a subaccount's `Status` (a `POST`, because that is what the SDK sends). `Status` is refused on a top-level account: suspending the credential that reaches this route would shut the API out of itself. These two are reachable on a suspended subaccount, so its parent can start it again. |
| `POST Calls.json` | places a call — it **registers**, appears on the Phone panel and waits to be answered. `queued` is the honest status. The `Url` you name is where it will be answered, so your own routing on that query string survives. `Twiml` may stand in for `Url`. `Method`, `StatusCallback`, `StatusCallbackMethod` and `StatusCallbackEvent` are all honoured. |
| `GET Calls.json` | lists this account's calls. `PageSize`, `Page` and `Status` narrow it. |
| `GET Calls/:sid.json` | one call. Reports `in-progress` while the sid is live. |
| `POST Calls/:sid.json` | `Status=completed` ends a live call and `canceled` drops a queued one, through the same teardown as any other hang-up. `Url` and `Twiml` are logged but do **not** redirect a live call. |
| `POST Messages.json` | sends, and actually delivers to the destination's `sms_url`. `StatusCallback` is honoured per message, signed with the sending account's token. `MessagingServiceSid` **resolves a sender**: with no `From`, the message goes out from a random number in that service's pool, and the service's own `StatusCallback` is the fallback. |
| `GET Messages.json` | lists messages. `To`, `From`, `PageSize` and `Page` narrow it. |
| `GET Messages/:sid.json` | one message. |
| `GET POST Keys.json` | list and mint API keys. The create is the only answer that carries the `secret` — a read never does, exactly as at Twilio. |
| `GET POST DELETE Keys/:sid.json` | fetch, rename (a `POST`, because that is what the SDK sends) and delete. A key of another account is a `20404`: across that boundary it does not exist. |
| `POST GET IncomingPhoneNumbers.json` | provision and list. A number provisioned here is one localio actually holds and answers for. `AreaCode` may stand in for `PhoneNumber`, as at Twilio: localio mints an unheld NANP number in that area code and hands it back. |
| `GET POST DELETE IncomingPhoneNumbers/:sid.json` | fetch, update, release. The update is a `POST`, because that is what the SDK sends. |
| `GET Recordings/:sid.json` | recording metadata. |
| `GET Calls/:sid/Recordings.json` | the recordings of one call. |
| `GET Recordings/:sid` | the WAV itself, and the one route here that is **unauthenticated** — a `RecordingUrl` gets pasted into places that will not send credentials. A `.wav` suffix is tolerated; `.mp3` answers `501`, because there is no encoder and a mislabelled WAV would make the client's decoder the thing that complains. |
| anything else under `/2010-04-01` | **`501`**, naming the path. Not a 404 — a gap in this tool should not read as a call that vanished. |

Responses are snake_case with RFC 2822 timestamps and `duration` as a string, because that
is what the Twilio SDK's own deserializer expects; anything no simulator can know (`price`,
`answered_by`, `caller_name`) is `null` rather than a plausible value.

### `/v1` — Messaging Services

Twilio keeps Messaging Services on a **different domain** from everything above —
`messaging.twilio.com/v1` rather than `api.twilio.com/2010-04-01` — and the SDK points it
separately, so a client that already talks to localio needs one more line:

```js
client.messaging.baseUrl = 'http://127.0.0.1:8080';
```

Same HTTP Basic, and a key works here too. **There is no `/Accounts/:sid` in these paths**,
which is the one way this family differs: with no account in the URL, the credential *is*
the account, so a parent's credentials act as the parent and there is no path in which to
name a child. The answers wear that domain's shape rather than the one above — ISO 8601
timestamps, and `meta.next_page_url` instead of `next_page_uri` — because that is what the
SDK's deserializer for this domain reads.

| | |
| --- | --- |
| `POST GET /v1/Services` | create and list. `FriendlyName` is required; `InboundRequestUrl`, `InboundMethod` and `StatusCallback` are honoured. |
| `GET POST /v1/Services/:sid` | fetch and update. The update is a `POST`, because that is what the SDK sends; an empty URL field clears it. |
| `DELETE /v1/Services/:sid` | delete. The pool goes; the numbers and the message history stay. |
| `POST GET /v1/Services/:sid/PhoneNumbers` | put a number in the pool, by `PhoneNumberSid`, and list what is in it. Another account's number is a `20404`; one already in a service is a `409` with `21712`, naming the service holding it. Adding a number already in *this* pool just answers it. |
| `DELETE /v1/Services/:sid/PhoneNumbers/:sid` | take a number out of the pool. |
| anything else under `/v1` | **`501`**, naming the path — the messaging domain redirects whole, and only Services is faked. |

The fields Twilio always sends (`sticky_sender`, `smart_encoding`, `usecase` and the rest)
are answered at their defaults so a client reading them gets a value rather than
`undefined`. None of them are honoured.

### `/admin` — accounts, keys, numbers and messaging services

Unauthenticated, and the reason this binds loopback — see **What it is not**. JSON in, JSON
out; a bad field answers `400` naming it.

| | |
| --- | --- |
| `GET POST /admin/accounts` | list and create. Creating answers the `auth_token` once — this is the only place it is handed over unasked. `parent_account_sid` makes the new account a **subaccount**; the parent must exist and must itself be top-level. |
| `GET PATCH DELETE /admin/accounts/:sid` | fetch, rename, re-token or set `status`, delete. `?reveal=1` is the only **read** under `/admin` that returns the `auth_token`. The sid and the parent are fixed at creation, and a `PATCH` naming either is a `400` rather than a silent no-op. Deleting is refused while the account still holds numbers **or subaccounts**, and takes its API keys with it — a key is a credential of the account, a number is a resource with history, and a subaccount is an account in its own right. |
| `GET POST /admin/keys` | list and mint. `account_sid` narrows the list; creating answers the `secret` once. The sid and secret may be pinned here, unlike over REST. |
| `GET PATCH DELETE /admin/keys/:sid` | fetch, rename, delete. `?reveal=1` is the only **read** that returns the `secret`. |
| `GET POST /admin/numbers` | list and provision. `account_sid` narrows the list. |
| `GET PATCH DELETE /admin/numbers/:sid` | fetch, update, release. A blank URL field clears it, an absent one keeps it; the number itself cannot be changed. Releasing keeps the call and message history. |
| `GET POST /admin/messaging-services` | list and create. `account_sid` narrows the list. `phone_numbers` states the pool in E.164; a name in it that is not held, or is held by another account, is a `400` **before anything is written**. |
| `GET PATCH DELETE /admin/messaging-services/:sid` | fetch, update, delete. The sid and the account are fixed at creation, and a `PATCH` naming either is a `400` rather than a silent no-op. Deleting takes the pool and nothing else: the numbers keep their own URLs and the messages keep the sid. |
| `POST /admin/messaging-services/:sid/numbers` | put a number in the pool, by `phone_number_sid`. Another account's number is a `400`, and one already in a service is a `409` naming the `MG…` in the way. |
| `DELETE /admin/messaging-services/:sid/numbers/:numberSid` | take it out again. |
| `POST /admin/seed` | the same file `--seed` reads, over HTTP. It upserts, so running it twice is not an error. |

### `/api` — what the UI draws

Unauthenticated, and this process talking to its own page: the shapes are the page's, not
Twilio's, with epoch-second timestamps.

| | |
| --- | --- |
| `GET /healthz` | `{"status":"ok"}`, and nothing else. |
| `GET /api/settings` | the public URL, the timeouts and the counts the header shows. Never a token or a secret. |
| `GET /api/calls` | call history. `status` and `limit` narrow it. |
| `GET /api/calls/:sid` | one call, with its event log and its recordings. |
| `GET /api/calls/:sid/events` | just the event log — what a call's `events` toggle polls. |
| `DELETE /api/calls/:sid` | **Decline.** The row is kept as `canceled` and no webhook is posted at all. `409` if the call is not waiting. |
| `POST /api/calls/:sid/claim` | say you are picking this one up, so other tabs grey the row out. `{holder}` is the tab's own id. `409` if somebody else has it or the call is not waiting. **Advisory** — the DB is what makes answering once-only. |
| `DELETE /api/calls/:sid/claim` | give it back after a pickup that did not happen. `?holder=` must match, and `204` either way. |
| `GET /api/calls/stream` | **Server-Sent Events**, for the strip of calls waiting to be picked up. See below. |
| `GET /api/messages` | history, or one thread when both `a` and `b` are given. |
| `GET /api/threads` | one summary row per pair of numbers. |
| `POST /api/messages` | injects an **inbound** message from any number at all, held or not — the Phone panel's compose box, and the way to be somebody else's phone. |
| `GET /api/recordings` | recording list. `call_sid` narrows it. |
| `GET /api/recordings/:sid` | one recording, with the media URL your application was handed. |

#### `GET /api/calls/stream`

Server-Sent Events, so a call that is waiting shows up now rather than on the page's next
two-second poll. Nothing to send and nothing to authenticate:

```console
$ curl -N http://127.0.0.1:8080/api/calls/stream
retry: 2000

event: snapshot
data: {"calls":[…]}

event: ringing
data: {"kind":"ringing","call":{"sid":"CA…","status":"queued","claimed_by":null,…}}
```

The first frame is always `snapshot`, the calls currently `queued`, so a client that
connects late — or reconnects, which `EventSource` does on its own — is in step without a
second request. After that, one frame per change, each carrying the same call shape
`GET /api/calls` returns:

| | |
| --- | --- |
| `ringing` | a new call is waiting — your application placed one through `Calls.json`. |
| `claimed` | somebody clicked **Pick up**; `claimed_by` says which tab. |
| `released` | that pickup did not happen, so the call is up for grabs again. |
| `taken` | it has been answered. It is no longer waiting for anybody. |
| `declined` | it was declined, and the row is `canceled`. |

A `: ping` comment goes out every 15 s so an idle stream is not mistaken for a dead one.

**Advisory, like the claim.** `Calls.answer()`'s conditional UPDATE is still the only thing
that makes a pickup happen once, and the page keeps its two-second poll: a stream that
dropped a frame, or never connected, is corrected on the next tick. Do not build anything
on this that the poll could not also produce.

### `/control` — the handset socket

`GET /control` upgrades to a WebSocket, unauthenticated. One socket is one call. Binary
frames are the microphone and nothing else; text frames are JSON control — `dial`, `dtmf`,
`mark`, `hangup` going up, and `webhook`, `call`, `verb`, `say`, `play`,
`recording_started`, `recording_stopped`, `connected`, `mark`, `clear`, `error`, `closed`
coming back. A `dial` carrying a `call_sid` **adopts** that queued call rather than minting
a new one; its optional `holder` is the claim the page took when Pick up was clicked, and
it is checked only so a tab that lost is told early — see below.

This is the only socket localio *serves*. The `<Connect><Stream>` socket is one it **dials
outward**, at the URL the TwiML named.

Everything else is `public/`, served at `/` and registered last, so it only ever sees a
path nothing above matched.

## Answering a call your application placed

1. Your application calls `POST …/Calls.json`. localio mints the `CA…`, **keeps the row**,
   and answers `queued`. Nothing has rung yet, which is also true of a real Twilio.
2. The call appears in the strip at the top of the Phone panel, whichever of your numbers
   it went out on — you do not have to already be pointed at that number to see it.
3. **Pick up** takes it — once, so a second tab cannot answer the same call — and the call
   **adopts** that `CA…` rather than minting a new one. It is the sid your application was
   already told, so it has to be the sid on everything that follows. The picker moves to the
   number the call is on.

   What makes it once is a conditional `UPDATE … WHERE status = 'queued'`, so it holds
   across tabs and across a restart. On top of that, clicking **Pick up** takes an in-memory
   **claim** on the call, which the other tabs see on their next poll and grey the row out.
   That is a courtesy, not the guarantee: answering does not reach the server until after
   the browser has opened its socket and asked for the microphone, and without the claim the
   tab that lost would walk through all of that before finding out. A claim expires after a
   few seconds, because the tab that claimed and then died is not coming back to release it.
4. The voice webhook goes to the `Url` the placement named, verbatim, with
   `Direction: outbound-api`.
5. The status callback goes to the `StatusCallback` the placement named, verbatim —
   filtered by `StatusCallbackEvent`, which defaults to `completed` alone as at Twilio.
   localio can report `initiated` (the placement registered), `ringing` (a tab took the
   queued row), `answered` (the document parsed) and `completed` (teardown). Each carries
   `SequenceNumber`, one monotonic sequence per call.

**Decline** drops the call and posts no webhook at all, because a call nobody picked up
never reached your application.

## Configuration

Every setting has two spellings — an environment variable and the same name as a flag —
and **the flag wins**. The flag is the one-off, the variable is the standing arrangement.
Nothing is read below the entrypoint, and there is no config file.

The variables are unprefixed, so a `PORT` or `DB` already exported in your shell for
something else will be picked up here. A flag is how you override one without unsetting it.

```bash
node dist/index.js --port 9000 --db ./data/scratch.db --log-level debug
npm run dev -- --help     # the table below, with the live defaults
```

| flag | variable | default | note |
| --- | --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` | deliberately loopback — see below |
| `--port` | `PORT` | `8080` | |
| `--public-url` | `PUBLIC_URL` | `http://<host>:<port>` | what a `RecordingUrl` is built from — this server's address **as your application sees it**. Unset, it follows `--host` and `--port` (a wildcard bind reads back as `127.0.0.1`); set it when that address is a tunnel. |
| `--db` | `DB` | `./data/localio.db` | `:memory:` for a database that does not outlive the process |
| `--recordings-dir` | `RECORDINGS_DIR` | `./data/recordings` | |
| `--seed` | `SEED` | — | a JSON file of accounts and numbers, upserted at boot |
| `--stream-url-override` | `STREAM_URL_OVERRIDE` | — | dial this origin instead of the one the TwiML named. The origin only. |
| `--webhook-timeout-ms` | `WEBHOOK_TIMEOUT_MS` | `15000` | |
| `--log-level` | `LOG_LEVEL` | `info` | `debug` adds bodies — see below |

At `info` the terminal carries one line per REST request your application made
(`twilio api`: method, path, status, ms) and one per webhook localio posted (`webhook`:
kind, method, URL, status, ms). A webhook that never reached anything — a refused
connection, a timeout — is a `warn` rather than a status, as is a `/2010-04-01` path
localio does not fake. `--log-level debug` adds the bodies to both: the request form and
the response payload for a REST call, and the signed parameters and the returned document
for a webhook, each truncated. Nothing logs a request header, so an account's auth token
does not end up in a paste of the terminal. Only `/2010-04-01` and `/v1` are logged — the
Phone panel's own polling of `/api` stays silent, which is what keeps a live call
readable.

There is no encryption key and no secret that is not a row — auth tokens and API key
secrets are both stored as they are typed: localio **is** the account holder. Keys are not
seedable; the seed file pins accounts, numbers and messaging services. A seeded account may
name a `parent_account_sid`, in either order — the parent may be listed after the child.

A `messaging_services` entry pins an `MG…` the same way an account pins its sid, so the one
in your application's own configuration keeps working across restarts; without a `sid` it
is keyed by `friendly_name` instead, and never re-minted on a second run. Its
`phone_numbers` list is **declarative** — it is what the pool becomes, so re-applying
converges rather than piling members up — and it is applied after the numbers, so it may
name ones the same file has just created.

## What it is not

- **Not deployable.** Nothing here is authenticated except the REST API: `/admin` hands out
  auth tokens and API key secrets, `/api` serves every message body it has carried, and recordings are served
  without credentials. It listens on `127.0.0.1` and should stay there. It warns loudly if
  you widen it.
- **Not a carrier.** A message to a number it does not hold is stored, not delivered. A
  provisioned number is one *it* holds, not one anybody can dial.
- **Not complete TwiML.** `<Gather>` and `<Dial>` are not implemented; they are logged and
  skipped, and the executor is shaped so they drop in. `<Say loop="0">` plays once rather
  than until the call ends, and `<Play digits=…>` is logged rather than synthesised.
- **Not a speech engine.** `<Say>` shows text. There is no TTS and no transcription.
- **Not an MP3 encoder.** Recordings are WAV; `<Play>` reads WAV.
- **Not a retrying webhook client.** One attempt, no fallback URL. A `voice_fallback_url`
  is accepted onto the resource and never called, because the failure this exists to show
  you is the first one, not the second.
- **Not a call router.** `POST Calls/:sid.json` will end a call but not redirect one:
  changing the document under a live call means abandoning whatever verb is mid-flight,
  and the executor has no cancellation to hang that on.
- **No answering machine detection.** `AnsweredBy` is always `null` and `MachineDetection`
  is ignored. Nor is there a ring timeout: `Timeout` is ignored and a queued call waits
  until a tab takes it or somebody declines it.
- **Not a full Messaging Service.** The pool and the shared inbound URL are real; the rest
  of Twilio's service resource is answered at its defaults and honoured nowhere. There is no
  sticky sender, no smart encoding, no area-code geomatch, no scheduling and no A2P
  registration.
- 
## License

MIT — see [LICENSE](LICENSE).
