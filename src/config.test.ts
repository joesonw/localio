import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadConfig, usage } from './config.js';

/**
 * Precedence is the kind of thing that inverts silently.
 *
 * Nothing fails when a flag loses to a variable: the process starts, listens, and serves
 * — on the wrong port, against the wrong database — and the person who typed `--db` spends
 * the afternoon looking at rows they did not write. So the direction is asserted directly,
 * both ways round, rather than left to be noticed.
 *
 * The derivations are re-asserted through a flag as well. They used to be reachable only
 * from the environment, and a second source that skipped the trailing-slash trim would put
 * a double slash in every `RecordingUrl` it built.
 */

test('a variable is read when there is no flag', () => {
  assert.equal(loadConfig({ PORT: '9098' }, []).port, 9098);
});

test('a flag is read when there is no variable', () => {
  assert.equal(loadConfig({}, ['--port', '9099']).port, 9099);
});

test('the flag beats the variable', () => {
  const config = loadConfig(
    { PORT: '9098', HOST: '0.0.0.0', LOG_LEVEL: 'warn' },
    ['--port', '9099', '--log-level', 'debug'],
  );
  assert.equal(config.port, 9099);
  assert.equal(config.logLevel, 'debug');
  // Untouched by the command line, so the variable still stands.
  assert.equal(config.host, '0.0.0.0');
});

test('--flag=value and --flag value are the same thing', () => {
  assert.equal(loadConfig({}, ['--port=9099']).port, 9099);
  assert.deepEqual(loadConfig({}, ['--port=9099']), loadConfig({}, ['--port', '9099']));
});

test('neither source leaves the schema default', () => {
  const config = loadConfig({}, []);
  assert.equal(config.port, 8080);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.publicUrl, 'http://127.0.0.1:8080');
  assert.equal(config.webhookTimeoutMs, 15_000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.seedPath, '');
});

/**
 * `PUBLIC_URL` is not a literal default but a derived one, and the failure it exists to
 * prevent is silent: a `RecordingUrl` naming 8080 after `--port 9000` moved the listener is
 * a URL the SDK fetches happily and nothing answers.
 */
test('an unset public url follows the host and port being bound', () => {
  assert.equal(loadConfig({}, ['--port', '9000']).publicUrl, 'http://127.0.0.1:9000');
  assert.equal(loadConfig({ PORT: '9000' }, []).publicUrl, 'http://127.0.0.1:9000');
  // A wildcard bind is not an address anything can fetch back.
  assert.equal(loadConfig({ HOST: '0.0.0.0', PORT: '9000' }, []).publicUrl, 'http://127.0.0.1:9000');
  assert.equal(loadConfig({ HOST: '::' }, []).publicUrl, 'http://127.0.0.1:8080');
  // Unbracketed, `http://::1:8080` has a host of `::1:8080` and no port at all.
  assert.equal(loadConfig({}, ['--host', '::1']).publicUrl, 'http://[::1]:8080');
  // Blank is how a variable is unset in a shell, and means the same as absent.
  assert.equal(loadConfig({ PUBLIC_URL: '' }, ['--port', '9000']).publicUrl, 'http://127.0.0.1:9000');
});

test('a public url that was given beats the derivation, and is still trimmed', () => {
  assert.equal(
    loadConfig({}, ['--host', '0.0.0.0', '--port', '9000', '--public-url', 'http://tunnel.example/']).publicUrl,
    'http://tunnel.example',
  );
});

test('an unknown flag is refused, with the usage block', () => {
  assert.throws(
    () => loadConfig({}, ['--prot', '9099']),
    (error: Error) => error.message.includes("--prot") && error.message.includes('Usage: localio'),
  );
});

test('a flag with no value is refused', () => {
  assert.throws(() => loadConfig({}, ['--port']), /Usage: localio/);
});

test('a flag value still has to satisfy the schema', () => {
  assert.throws(() => loadConfig({}, ['--port', 'abc']));
  assert.throws(() => loadConfig({}, ['--port', '0']));
  assert.throws(() => loadConfig({}, ['--log-level', 'nope']));
  assert.throws(() => loadConfig({}, ['--public-url', 'not-a-url']));
});

test('the derivations hold when a flag drives them', () => {
  assert.equal(
    loadConfig({}, ['--public-url', 'http://tunnel.example/']).publicUrl,
    'http://tunnel.example',
  );
  assert.equal(
    loadConfig({}, ['--stream-url-override', 'http://localhost:3000//']).streamUrlOverride,
    'http://localhost:3000',
  );
  assert.equal(loadConfig({}, ['--db', ':memory:']).dbPath, ':memory:');
  assert.equal(loadConfig({}, ['--db', './x.db']).dbPath, resolve('./x.db'));
  assert.equal(loadConfig({}, ['--seed', './seed.json']).seedPath, resolve('./seed.json'));
});

test('the usage text names every flag and its variable', () => {
  const text = usage();
  for (const flag of ['--host', '--port', '--public-url', '--db', '--recordings-dir', '--seed', '--stream-url-override', '--webhook-timeout-ms', '--log-level', '--help']) {
    assert.ok(text.includes(flag), `usage() does not mention ${flag}`);
  }
  assert.ok(text.includes('PORT'));
  // The defaults are read back out of the schema, so this is the real one.
  assert.ok(text.includes('(8080)'));
  // Derived rather than literal, so the table says what it follows instead of `—`.
  assert.ok(text.includes('(http://<host>:<port>)'));
});
