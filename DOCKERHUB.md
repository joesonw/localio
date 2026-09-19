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
                           │  <Record>    │ ──▶ /data/recordings/RE….wav
                           │              │ ──signed action POST─▶ your handler
                           └──────────────┘ ──signed status POST─▶ status webhook
```

## Run it

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v localio-data:/data joesonw/localio
```

Open <http://127.0.0.1:8080>, create an account in the **Admin** panel, add a number, and
point its webhook URLs at your application. Then point your application at localio:

```js
const client = twilio(accountSid, authToken);
client.api.baseUrl = 'http://127.0.0.1:8080';
```

That one assignment redirects the SDK's whole `api` domain — calls, messages, provisioning
and recordings all land here.

## Publish the port to loopback

The image binds `0.0.0.0` because loopback inside a container is nobody's address — so
publish the port to `127.0.0.1` as above and it is as reachable as running it on the host
was, and no more. It will still warn on boot that nothing here is authenticated; that
warning is right.

## The `/data` volume

`DB` and `RECORDINGS_DIR` already point into `/data`, so one volume holds the database and
the recordings:

| path | what |
| --- | --- |
| `/data/localio.db` | SQLite, in WAL mode — the volume also holds its `-wal` and `-shm` |
| `/data/recordings` | the WAVs `<Record>` writes, served back as `RecordingUrl` |

The container runs as the unprivileged `node` user and `/data` in the image is owned by it.
A named volume inherits that owner; a **bind mount of a host directory does not**, so a
`-v "$PWD/data:/data"` owned by root fails to open the database. Either use a named volume,
or `chown` the host directory to uid 1000 first.

## Seeding

A seed file of accounts, numbers and messaging services is applied on every boot, upserting,
so your application's sids survive a restart. Mount it and name it:

```bash
docker run --rm -p 127.0.0.1:8080:8080 \
  -v localio-data:/data \
  -v "$PWD/seed.example.json:/seed.json:ro" \
  joesonw/localio node dist/index.js --seed /seed.json
```

[`seed.example.json`](https://github.com/joesonw/localio/blob/main/seed.example.json) is a
template.

## Configuration

Every setting has two spellings — an environment variable and the same name as a flag — and
**the flag wins**. In a container, `-e VAR=…` is the standing arrangement and a flag after
the image name is the one-off. Nothing is read below the entrypoint, and there is no config
file.

| flag | variable | default in this image | note |
| --- | --- | --- | --- |
| `--host` | `HOST` | `0.0.0.0` | the image widens it; publish the port to loopback |
| `--port` | `PORT` | `8080` | the only port exposed |
| `--public-url` | `PUBLIC_URL` | `http://<host>:<port>` | what a `RecordingUrl` is built from — see below |
| `--db` | `DB` | `/data/localio.db` | `:memory:` for a database that does not outlive the process |
| `--recordings-dir` | `RECORDINGS_DIR` | `/data/recordings` | |
| `--seed` | `SEED` | — | a JSON file of accounts and numbers, upserted at boot |
| `--stream-url-override` | `STREAM_URL_OVERRIDE` | — | dial this origin instead of the one the TwiML named. The origin only. |
| `--webhook-timeout-ms` | `WEBHOOK_TIMEOUT_MS` | `15000` | |
| `--log-level` | `LOG_LEVEL` | `info` | `debug` adds request and webhook bodies |

`PUBLIC_URL` is this server's address **as your application sees it**, which from inside a
container is rarely the default: set it when recordings come back with a URL your
application cannot fetch.

```bash
docker run --rm -p 127.0.0.1:8080:8080 -v localio-data:/data \
  -e PUBLIC_URL=http://host.docker.internal:8080 \
  joesonw/localio
```

## Tags

| tag | published from |
| --- | --- |
| `latest` | the newest `v*` release tag |
| `1.2.3`, `1.2`, `1` | each `v*` release tag |
| `main` | every push to `main` |

Built for `linux/amd64` and `linux/arm64`.

## Not deployable

Nothing here is authenticated except the Twilio REST API. `/admin` hands out auth tokens and
API key secrets, `/api` serves every message body it has carried, and recordings are served
without credentials. This is a development tool: keep the published port on `127.0.0.1`.

## The rest

The TwiML verbs it runs, the `/2010-04-01`, `/v1`, `/admin` and `/api` routes, the Phone and
Admin panels, and what it deliberately is not, are all in the project README:

- **[github.com/joesonw/localio](https://github.com/joesonw/localio#readme)** — the full documentation
- **[@joesonw/localio](https://www.npmjs.com/package/@joesonw/localio)** — the same thing on npm, if you would rather not use a container
- MIT — see [LICENSE](https://github.com/joesonw/localio/blob/main/LICENSE)
