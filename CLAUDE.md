# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                       # tsx watch on src/index.ts -> http://127.0.0.1:8080
npm run dev -- --help             # the full flag/env table with live defaults
npm run build                     # tsc -p tsconfig.build.json, then copies src/db/*.sql into dist/db/
npm start                         # node dist/index.js (requires build)
npm run typecheck                 # tsc --noEmit
npm test                          # typecheck (incl. tests) + node's test runner via tsx

npx tsx --test src/g711.test.ts                                  # one file
npx tsx --test --test-name-pattern 'mulaw' src/g711.test.ts      # one test
npm run dev -- --db :memory: --seed seed.example.json            # throwaway run
```

`tsconfig.json` type-checks everything including tests; `tsconfig.build.json` is the same
minus `*.test.ts`. `npm test` runs both halves, so tests are never unchecked. Tests are
hermetic: no sockets, no network, no fixtures beyond a temp dir.

## What this is

A local stand-in for Twilio: it answers the Twilio REST API, posts signed webhooks at your
application, executes the TwiML that comes back, bridges Media Streams, and stores
everything in SQLite. The browser tab at `/` is the handset (mic, speaker, keypad). See
`README.md` for the user-facing behaviour of every verb, panel and endpoint — this file is
about the code.

## Architecture

The dependency shape is a straight line: `index.ts` reads config and opens the DB →
`server.ts` wires routes and the handset socket → a `CallSession` per live call drives the
TwiML executor, which reaches the outside world only through a host interface.

- **`src/index.ts`** — the only place that touches `process.env` or `process.argv`, and the
  only place the DB is opened or the seed applied. Everything below takes plain values
  through a constructor. Do not reach for config or env deeper in the tree.
- **`src/config.ts`** — every setting has exactly two spellings, `SCREAMING_CASE` env var
  and `--kebab-case` flag, **flag wins**. Names are unprefixed on purpose.
- **`src/server.ts`** — Fastify. **Registration order is load-bearing**: the Twilio API's
  `501` catch-all matches `/2010-04-01/*` and must come after every real route there
  (`registerTwilioApi` handles that internally), and `@fastify/static` is registered last.
  `@fastify/formbody` is mandatory — without it every form POST answers 415, which reads
  as a Twilio outage.
- **`src/call.ts`** (the biggest file) — one browser socket, one call. Posts the voice
  webhook, walks the TwiML, and for `<Connect><Stream>` sits between the browser's PCM16
  and the far end's µ-law.
- **`src/twiml/parse.ts` + `execute.ts`** — a small hand-written XML reader, then a walker.
  Verbs are either *sequential* (`<Say>`, `<Play>`, `<Pause>`, `<Record>` without `action`)
  or *terminal* (`<Hangup>`, `<Reject>`, `<Connect><Stream>`, `<Redirect>`, `<Record>` with
  `action`); the last two end the document by *replacing* it with a fetched one. The
  executor touches no socket, DB or clock — only `ExecutionHost`, which is what makes
  `execute.test.ts` possible. **Unknown verbs are logged and skipped, never fatal**
  (`<Gather>` and `<Dial>` take that path).
- **`src/db/`** — six stores over one `better-sqlite3` connection, exposed as `Store`.
  Routes take `Store`, never a raw `Db`; a route writing its own SQL is how a second sid
  mint site appears. Migrations are an append-only `STEPS` ladder in `open.ts` keyed on
  `PRAGMA user_version` — **never edit a released step**; step 2 is `002-api-keys.sql` and
  step 3 `003-subaccounts.sql`.
  The `.sql` files are read relative to the module, which is why the build copies them
  into `dist/db/`.
- **`src/routes/`** — three families plus static: `/2010-04-01` (Twilio REST, HTTP Basic
  against `accounts`), `/admin` (accounts, API keys and numbers, unauthenticated), `/api` (what the
  UI draws, unauthenticated). A subaccount is a *full* account carrying a
  `parent_account_sid`, so everything that takes an `account_sid` already works on one;
  the only code that knows the difference is `authenticate()` and the `Accounts.json`
  routes. `/api/calls/stream` is the one non-JSON route in the family: SSE, written
  straight onto `reply.raw` after `reply.hijack()`, fed by `call-feed.ts`.
- **`public/`** — no framework, no build step, plain ES modules. Render with `textContent`
  and `append`, never `innerHTML`: this page displays TwiML from another process and
  message bodies verbatim. Two panels: **Phone** and **Admin** (accounts, API keys, numbers). `app.js` owns the page,
  `handset.js` owns the socket and the audio, `autocomplete.js` is the number picker.
  **`state.sim` is what the Phone panel means by "here"** — the calls, the keypad and the
  conversations are all that one number's, so anything added there filters by it rather
  than asking again which number was meant. The pending-call strip above the picker is the
  one deliberate exception: it lists every queued call, because a call you cannot see is
  worse than a panel-wide one, and picking one up calls `setSim()` so everything below is
  back in step rather than widening anything else. The keypad is the page's, not the handset's:
  the same keys compose a number when idle and send DTMF when a call is up, and only
  `app.js` can see both.

## Invariants that fail silently when broken

These are each documented at their site; breaking one produces no error, just wrong
behaviour somewhere far away.

- **Signing.** `signature.ts` signs the *exact* URL requested, query string included, then
  every param sorted by key name. The URL signed and the URL posted to are one string
  (a number's `voice_url` column) so they cannot drift. Body and signature come from one
  map. `GET` webhooks sign the URL with params on it and an empty body. Failure mode: a
  blanket 403 with nothing naming the character that differed — hence
  `signature.test.ts`, which runs the real `twilio` SDK's `validateRequest` against our
  output. **`twilio` must stay a devDependency**; this is an independent implementation on
  purpose.
- **A key authenticates, it never signs.** `/2010-04-01` Basic accepts either an account
  sid with its auth token or an `SK…` API key of that account with its secret, and
  `authenticate()` returns the **`Account`** in both cases — which is what keeps
  `signature.ts` signing with `account.authToken`. Signing with a key secret instead
  produces webhooks the Twilio SDK's validator rejects with nothing naming why. A key of
  another account is a `20003` (the account exists, the credential does not open it); a
  key read across an account boundary is a `20404` (over there it does not exist).
- **A parent opens a child, but `authenticate()` returns the account in the *path*.** A
  subaccount (`parent_account_sid`, migration step 3) is opened by its own credential or
  its parent's, and the `Account` handed back is always the one the URL names — never the
  credential's. A call placed with a parent's credentials at a child's path is the child's
  call, and `call.ts` signs from the owning row's token; return the parent instead and
  every one of that child's webhooks is signed with the wrong token, which the SDK's
  validator rejects with nothing naming why. Non-`active` accounts are refused here with
  `20005`, except on `Accounts/:sid.json` itself — gating those would make `suspend` a
  one-way door, since the route that revives a child is the one being refused.
- **Sid adoption.** A call placed via `POST Calls.json` keeps its `CA…` when answered from
  the Phone panel. Never re-mint it — all sids go through `provider-id.ts`.
- **`Calls.answer()`'s `WHERE status = 'queued'` is what makes a pickup happen once**, and
  it is the only thing that does. `call-claims.ts` is an in-memory, TTL'd *hint* that
  narrows the window — answering does not reach the server until the `dial` frame does,
  which is after the browser has asked for the microphone, so the claim is how the losing
  tab is told early. It is advisory in both directions: never make it load-bearing, and
  never let a claim that could not be taken stand in for the conditional UPDATE.
- **`call-feed.ts` is a third advisory layer, and the page still polls.** `/api/calls/stream`
  pushes the five transitions of a waiting call (`ringing`, `claimed`, `released`, `taken`,
  `declined`) so the pending strip does not wait out a two-second tick. Publish *after* the
  fact is true in the DB or the claim map, never before, and publish nothing for a call
  that did not change — a `released` frame for a release that released nothing re-enables
  Pick up in every tab for a call somebody else now holds. `public/app.js` keeps
  `loadIncoming()` in the 2 s `refresh()` as the authoritative writer of `state.pending`;
  the stream only makes the common case immediate.
- **`LocalioServer.close()` calls `feed.close()` before `app.close()`.** An SSE response
  never ends on its own and Fastify's close waits on open connections, so with one page
  holding the stream the process simply does not exit — no error, no log line, Ctrl-C does
  nothing. `CallFeed.close()` exists only for this.
- **Marks are echoed after playback, not on receipt.** The browser sends the mark back from
  `onended`; the server only forwards. Echoing on arrival over-reports by the whole client
  buffer.
- **Teardown is one idempotent path**, and the status callback is posted from it, only for
  a call that actually connected.
- **REST response shape.** snake_case, RFC 2822 timestamps, `duration` as a string,
  unknowable fields (`price`, `answered_by`, `caller_name`) as `null`, unknown sids as
  Twilio's `20404` envelope, unimplemented paths as `501` naming the path. Each of these
  is what the Twilio SDK's deserializer actually needs.
- **Webhooks never throw.** `webhook.ts` returns a `WebhookResult`; a transport failure is
  status `0`. A 403, a 404 and an empty document are outcomes this tool exists to make
  legible.
- **Frame decoding never throws.** `control-protocol.ts` and `twilio-envelope.ts` return an
  `invalid`/`unknown` variant. Killing a live call over an unread frame is the worse bug.
- **8 kHz everywhere, one codec.** PCM16 mono 8 kHz on the browser wire (binary frames =
  audio, text frames = control); µ-law on the Twilio wire. `g711.ts` is the only conversion
  on the live path, and there is no resampler — `AudioContext({ sampleRate: 8000 })` does
  it in the browser. µ-law clips at 32635.

## Security posture

Nothing is authenticated except `/2010-04-01`. `/admin` hands out auth tokens, `/api`
serves every message body carried, and recordings are served without credentials. It binds
`127.0.0.1` and warns loudly otherwise. Do not add anything that assumes this is
deployable; if `/api` ever faces a reachable browser, it goes behind a session hook in the
same change.
