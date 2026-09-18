import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

/**
 * Configuration, from the environment and the command line and nowhere else.
 *
 * Read **once**, in `src/index.ts`; everything below the entrypoint takes plain values
 * through a constructor. There is no `process.env` and no `process.argv` anywhere else in
 * `src/`.
 *
 * Every setting has exactly two spellings — a `SCREAMING_CASE` variable and the same word
 * as a `--kebab-case` flag — and **the flag wins**. That is the whole precedence rule: a
 * flag is the one-off, the variable is the standing arrangement.
 *
 * The names are unprefixed, which is a decision and not an oversight: this process reads
 * `PORT` and `DB`, the names anything else in a shell would use. It is a development tool
 * run in a directory of its own, so the short name is the right one — but it does mean an
 * exported `PORT` meant for something else will be picked up here, and `--port` is how you
 * say otherwise without unsetting it.
 *
 * Note what is *not* here: there is no encryption key and no secret of any kind. In the
 * app this was extracted from a signing token was a sealed column that had to be opened;
 * here `localio` **is** the account holder, so a token is a row in `accounts` and the
 * only credentials in the process are ones it minted itself.
 */
const schema = z.object({
  /**
   * Deliberately loopback.
   *
   * This process answers a provider's REST API, forges signed webhooks and serves an
   * admin API that hands out auth tokens, none of it behind any authentication worth the
   * name. It is a development tool. `index.ts` warns loudly when this is widened.
   */
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /**
   * The origin a `RecordingUrl` is built from — what the application under test will
   * fetch a recording at. It is *this* server's address as that application sees it,
   * which is a tunnel rather than `127.0.0.1` when the two are not on one machine.
   *
   * Blank means *derive it from `HOST` and `PORT`*, which is the honest default: a fixed
   * one is a copy of those two settings that stops being true the moment either moves, and
   * a `RecordingUrl` naming a port nothing is listening on fails with nothing to say why.
   * A tunnel is still named here — the derivation only keeps the defaults in step.
   */
  PUBLIC_URL: z.string().url().or(z.literal('')).default(''),
  DB: z.string().default('./data/localio.db'),
  RECORDINGS_DIR: z.string().default('./data/recordings'),
  /** A JSON file of accounts and numbers, upserted at boot. Blank means none. */
  SEED: z.string().default(''),
  /**
   * Dial this origin instead of the one the TwiML named. **The origin only** — the path,
   * the query string and the `<Parameter>` children are the document's and are not this
   * setting's to touch.
   */
  STREAM_URL_OVERRIDE: z.string().default(''),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).default(15_000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

/**
 * The flag ↔ variable table, and the only place either spelling is named.
 *
 * Adding a setting is three edits and no more: an entry in the schema above, a row here,
 * and a field on `Config`. The schema stays the source of truth for the type, the
 * validation *and* the default — `usage()` reads the defaults back out of it rather than
 * restating them, so the help text cannot drift from what the process actually does.
 *
 * Nothing here is a boolean, so there are no `--no-…` spellings to think about; every
 * flag takes a value, in either `--flag value` or `--flag=value` form.
 */
const OPTIONS = [
  { flag: 'host', env: 'HOST', arg: '<host>' },
  { flag: 'port', env: 'PORT', arg: '<n>' },
  { flag: 'public-url', env: 'PUBLIC_URL', arg: '<url>', note: 'http://<host>:<port>' },
  { flag: 'db', env: 'DB', arg: '<path>' },
  { flag: 'recordings-dir', env: 'RECORDINGS_DIR', arg: '<path>' },
  { flag: 'seed', env: 'SEED', arg: '<path>' },
  { flag: 'stream-url-override', env: 'STREAM_URL_OVERRIDE', arg: '<url>' },
  { flag: 'webhook-timeout-ms', env: 'WEBHOOK_TIMEOUT_MS', arg: '<ms>' },
  { flag: 'log-level', env: 'LOG_LEVEL', arg: '<level>' },
] as const;

export interface Config {
  host: string;
  port: number;
  publicUrl: string;
  dbPath: string;
  recordingsDir: string;
  seedPath: string;
  streamUrlOverride: string;
  webhookTimeoutMs: number;
  logLevel: string;
}

/**
 * A setting the command line got wrong — an unknown flag, a missing value, a port that is
 * not a number.
 *
 * Distinguished from every other startup failure because it is the one class where the
 * stack trace is noise: the mistake is in what was typed, not in what ran. `index.ts`
 * prints the message and nothing else.
 */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/** The help text, generated from `OPTIONS` and the schema's own defaults. */
export function usage(): string {
  const defaults = schema.parse({});
  const spellings = OPTIONS.map((option) => ({
    ...option,
    left: `--${option.flag} ${option.arg}`,
  }));
  const flagWidth = Math.max(...spellings.map((option) => option.left.length));
  const envWidth = Math.max(...spellings.map((option) => option.env.length));
  const rows = spellings.map((option) => {
    const fallback = defaults[option.env];
    // `note` is for a default the schema cannot state as a literal because it is computed
    // from other settings; without it `--public-url` would advertise itself as unset.
    const note = 'note' in option ? option.note : undefined;
    const shown = note ?? (fallback === '' ? '—' : String(fallback));
    return `  ${option.left.padEnd(flagWidth)}  ${option.env.padEnd(envWidth)}  (${shown})`;
  });
  return [
    'Usage: localio [options]',
    '',
    'Every setting is a flag or the variable beside it. The flag wins.',
    '',
    ...rows,
    `  ${'-h, --help'.padEnd(flagWidth)}  ${''.padEnd(envWidth)}  show this and exit`,
    '',
  ].join('\n');
}

/**
 * Whether the command line asked for help.
 *
 * A plain scan rather than a parse, so `--help` still prints even when the rest of the
 * command line is nonsense — which is exactly when somebody reaches for it.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * `argv` defaults to **empty**, not to `process.argv`: the entrypoint passes it in, the
 * same way it passes the environment in, and a test that wants neither can ask for
 * neither.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): Config {
  const flags = parseFlags(argv);

  // The overlay, and the whole of the precedence rule. `schema.parse` sees this record
  // rather than the real environment, so a flag simply arrives as if it had been exported
  // — and an absent setting stays absent, which is what lets zod's `.default()` fill it.
  const sources: Record<string, string> = {};
  for (const option of OPTIONS) {
    const value = flags[option.flag] ?? env[option.env];
    if (value !== undefined) sources[option.env] = value;
  }

  const parsed = parseSources(sources);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    // Trailing slash trimmed here rather than at every join site: a `RecordingUrl` with a
    // double slash in it is a URL the SDK will happily fetch and a router will not match.
    // Unset, it follows the address actually being bound rather than a literal that would
    // go on naming 8080 after `--port` moved.
    publicUrl: parsed.PUBLIC_URL
      ? parsed.PUBLIC_URL.replace(/\/+$/, '')
      : defaultPublicUrl(parsed.HOST, parsed.PORT),
    dbPath: parsed.DB === ':memory:' ? ':memory:' : resolve(parsed.DB),
    recordingsDir: resolve(parsed.RECORDINGS_DIR),
    seedPath: parsed.SEED ? resolve(parsed.SEED) : '',
    streamUrlOverride: parsed.STREAM_URL_OVERRIDE.replace(/\/+$/, ''),
    webhookTimeoutMs: parsed.WEBHOOK_TIMEOUT_MS,
    logLevel: parsed.LOG_LEVEL,
  };
}

/**
 * The address to name when nobody named one: where this server is about to listen.
 *
 * A wildcard bind is not an address anything can fetch, so it becomes loopback — the far
 * side of a `RecordingUrl` is an HTTP client, not a `bind(2)` call. An IPv6 literal is
 * bracketed, without which `http://::1:8080` parses as a host of `::1:8080` and no port.
 */
function defaultPublicUrl(host: string, port: number): string {
  const reachable = host === '' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const authority = reachable.includes(':') ? `[${reachable}]` : reachable;
  return `http://${authority}:${port}`;
}

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const options = {
    ...Object.fromEntries(OPTIONS.map((option) => [option.flag, { type: 'string' as const }])),
    help: { type: 'boolean' as const, short: 'h' },
  };
  try {
    const { values } = parseArgs({
      args: [...argv],
      options,
      strict: true,
      allowPositionals: false,
    });
    // Every entry but `help` is declared `type: 'string'`, and `help` is not in `OPTIONS`.
    return values as Record<string, string | undefined>;
  } catch (error: unknown) {
    // `parseArgs` names the offending token and stops there. Worth the usage block:
    // a mistyped flag is almost always a forgotten spelling.
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${detail}\n\n${usage()}`);
  }
}

function parseSources(sources: Record<string, string>): z.infer<typeof schema> {
  const result = schema.safeParse(sources);
  if (result.success) return result.data;
  // Reported against the *flag* when one was given, because that is the spelling in front
  // of whoever is reading. A raw zod tree names `PORT` and buries the rest.
  const lines = result.error.issues.map((issue) => {
    const key = String(issue.path[0] ?? '');
    const option = OPTIONS.find((candidate) => candidate.env === key);
    const named = option ? `--${option.flag} / ${option.env}` : key;
    return `  ${named}: ${issue.message}`;
  });
  throw new UsageError(`localio was given a setting it cannot use:\n${lines.join('\n')}`);
}
