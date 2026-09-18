import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Recorder } from './recorder.js';
import { decodeWav, SAMPLE_RATE } from './wav.js';

const FRAME = (SAMPLE_RATE / 50) * 2;

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'localio-rec-'));
}

/** 20 ms of audible tone. */
function loud(): Buffer {
  const out = Buffer.allocUnsafe(FRAME);
  for (let i = 0; i < FRAME / 2; i += 1) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 12000), i * 2);
  }
  return out;
}

/** 20 ms of silence. */
function quiet(): Buffer {
  return Buffer.alloc(FRAME);
}

function recorder(options: Partial<ConstructorParameters<typeof Recorder>[0]> = {}): Recorder {
  return new Recorder({
    sid: 'RE' + '0'.repeat(32),
    dir: dir(),
    maxLengthSeconds: 10,
    timeoutSeconds: 0,
    finishOnKey: '#',
    trim: false,
    ...options,
  });
}

test('a recording writes a wav that reads back at the line format', () => {
  const rec = recorder();
  for (let i = 0; i < 50; i += 1) rec.write(loud());
  rec.abort();
  const saved = rec.save();
  const wav = decodeWav(readFileSync(saved.path));
  assert.equal(wav.sampleRate, SAMPLE_RATE);
  assert.equal(wav.channels, 1);
  assert.equal(wav.samples.length, 50 * FRAME);
  assert.equal(saved.durationSeconds, 1);
});

/** **`maxLength` is a duration**, so a frame that straddles it contributes the part that fits. */
test('maxLength stops the recording and trims the straddling frame', () => {
  const rec = recorder({ maxLengthSeconds: 0.1 });
  let stopped: string | null = null;
  for (let i = 0; i < 20 && stopped === null; i += 1) stopped = rec.write(loud());
  assert.equal(stopped, 'max-length');
  const wav = decodeWav(readFileSync(rec.save().path));
  assert.equal(wav.samples.length, 0.1 * SAMPLE_RATE * 2, 'exactly the budget, not a frame more');
});

/** A frame after it stopped is dropped rather than throwing — the socket and the verb do not stop together. */
test('audio arriving after the stop is dropped', () => {
  const rec = recorder({ maxLengthSeconds: 0.02 });
  rec.write(loud());
  assert.equal(rec.write(loud()), null);
  assert.ok(rec.done);
});

test('a finishOnKey digit stops it and is reported as Digits', () => {
  const rec = recorder({ finishOnKey: '#*' });
  rec.write(loud());
  assert.equal(rec.dtmf('1'), null, 'a key not in finishOnKey does nothing');
  assert.equal(rec.dtmf('#'), 'finish-key');
  assert.equal(rec.save().digits, '#');
});

/** A hangup under the verb is reported as the literal `hangup`, which is what Twilio sends. */
test('a hangup is reported as Digits=hangup', () => {
  const rec = recorder();
  rec.write(loud());
  assert.equal(rec.hangup(), 'hangup');
  assert.equal(rec.save().digits, 'hangup');
});

/**
 * **Silence before anybody has spoken does not count.** Otherwise the timeout fires on the
 * first frames and every recording is empty.
 */
test('the silence timeout does not fire before anything has been heard', () => {
  const rec = recorder({ timeoutSeconds: 0.1 });
  for (let i = 0; i < 50; i += 1) {
    assert.equal(rec.write(quiet()), null, 'leading silence must not end the recording');
  }
});

test('silence after speech ends the recording', () => {
  const rec = recorder({ timeoutSeconds: 0.1 });
  for (let i = 0; i < 10; i += 1) rec.write(loud());
  let stopped: string | null = null;
  for (let i = 0; i < 20 && stopped === null; i += 1) stopped = rec.write(quiet());
  assert.equal(stopped, 'silence');
});

test('trim drops silence at each end and keeps what is between', () => {
  const rec = recorder({ trim: true });
  for (let i = 0; i < 10; i += 1) rec.write(quiet());
  for (let i = 0; i < 10; i += 1) rec.write(loud());
  for (let i = 0; i < 10; i += 1) rec.write(quiet());
  rec.abort();
  const wav = decodeWav(readFileSync(rec.save().path));
  assert.equal(wav.samples.length, 10 * FRAME, 'exactly the audible middle');
});

/** **Idempotent**: two files for one recording would be two `RE…` that are not. */
test('saving twice returns the same outcome', () => {
  const rec = recorder();
  rec.write(loud());
  rec.abort();
  assert.deepEqual(rec.save(), rec.save());
});

test('a recording with no audio at all still produces a readable wav', () => {
  const rec = recorder();
  rec.abort();
  const saved = rec.save();
  assert.equal(saved.durationSeconds, 0);
  assert.equal(decodeWav(readFileSync(saved.path)).samples.length, 0);
});
