import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pcm16ToMulaw } from './g711.js';
import { decodeWav, durationSeconds, encodeWav, resample, SAMPLE_RATE, toMono, wavToLineFormat } from './wav.js';

function sine(samples: number, hz: number, rate: number): Buffer {
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 10000), i * 2);
  }
  return out;
}

test('a written wav reads back identically', () => {
  const samples = sine(800, 440, SAMPLE_RATE);
  const decoded = decodeWav(encodeWav(samples));
  assert.equal(decoded.sampleRate, SAMPLE_RATE);
  assert.equal(decoded.channels, 1);
  assert.deepEqual(decoded.samples, samples);
});

test('the header is the canonical 44 bytes', () => {
  const wav = encodeWav(Buffer.alloc(100));
  assert.equal(wav.length, 144);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  // The RIFF size counts everything after the field itself, not the whole file.
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(40), 100);
});

/**
 * **Chunks are walked, not assumed at byte 44.** A file with a `LIST` between `fmt ` and
 * `data` read at a fixed offset plays as noise followed by the audio.
 */
test('a chunk between fmt and data does not shift the audio', () => {
  const samples = sine(200, 300, SAMPLE_RATE);
  const plain = encodeWav(samples);
  const list = Buffer.alloc(8 + 10);
  list.write('LIST', 0, 'ascii');
  list.writeUInt32LE(10, 4);
  const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  withList.writeUInt32LE(withList.length - 8, 4);
  assert.deepEqual(decodeWav(withList).samples, samples);
});

/** An odd chunk size is followed by a pad byte that is not counted in it. */
test('an odd-sized chunk is padded past correctly', () => {
  const samples = sine(200, 300, SAMPLE_RATE);
  const plain = encodeWav(samples);
  const odd = Buffer.alloc(8 + 4);
  odd.write('fact', 0, 'ascii');
  odd.writeUInt32LE(3, 4);
  const withOdd = Buffer.concat([plain.subarray(0, 36), odd, plain.subarray(36)]);
  withOdd.writeUInt32LE(withOdd.length - 8, 4);
  assert.deepEqual(decodeWav(withOdd).samples, samples);
});

test('a µ-law wav decodes through the codec', () => {
  const samples = sine(400, 440, SAMPLE_RATE);
  const mulaw = pcm16ToMulaw(samples);
  const header = encodeWav(Buffer.alloc(0));
  // Format 7, 8 bits, and the data is one byte per sample.
  header.writeUInt16LE(7, 20);
  header.writeUInt16LE(8, 34);
  header.writeUInt16LE(1, 32);
  header.writeUInt32LE(SAMPLE_RATE, 28);
  header.writeUInt32LE(mulaw.length, 40);
  const wav = Buffer.concat([header, mulaw]);
  wav.writeUInt32LE(wav.length - 8, 4);
  assert.equal(decodeWav(wav).samples.length, samples.length);
});

/** **8-bit PCM in a WAV is unsigned**, centred on 128 — the one non-obvious reading. */
test('8-bit pcm is read as unsigned', () => {
  const header = encodeWav(Buffer.alloc(0));
  header.writeUInt16LE(8, 34);
  header.writeUInt16LE(1, 32);
  header.writeUInt32LE(3, 40);
  const wav = Buffer.concat([header, Buffer.from([128, 255, 0])]);
  wav.writeUInt32LE(wav.length - 8, 4);
  const { samples } = decodeWav(wav);
  assert.equal(samples.readInt16LE(0), 0, '128 is silence');
  assert.ok(samples.readInt16LE(2) > 30000, '255 is full positive');
  assert.ok(samples.readInt16LE(4) < -30000, '0 is full negative');
});

test('stereo averages down to mono', () => {
  const stereo = Buffer.allocUnsafe(8);
  stereo.writeInt16LE(1000, 0);
  stereo.writeInt16LE(3000, 2);
  stereo.writeInt16LE(-500, 4);
  stereo.writeInt16LE(-1500, 6);
  const mono = toMono({ samples: stereo, sampleRate: SAMPLE_RATE, channels: 2 });
  assert.equal(mono.channels, 1);
  assert.equal(mono.samples.readInt16LE(0), 2000);
  assert.equal(mono.samples.readInt16LE(2), -1000);
});

test('8 kHz passes through the resampler untouched', () => {
  const samples = sine(400, 440, SAMPLE_RATE);
  const out = resample({ samples, sampleRate: SAMPLE_RATE, channels: 1 });
  assert.deepEqual(out.samples, samples);
});

test('44.1 kHz comes down to 8 kHz with the duration preserved', () => {
  const seconds = 0.5;
  const samples = sine(Math.round(44_100 * seconds), 440, 44_100);
  const out = resample({ samples, sampleRate: 44_100, channels: 1 });
  assert.equal(out.sampleRate, SAMPLE_RATE);
  assert.ok(
    Math.abs(durationSeconds(out.samples) - seconds) < 0.01,
    `duration drifted to ${durationSeconds(out.samples)}`,
  );
});

test('the whole play path takes a stereo 44.1 kHz wav to line format', () => {
  const frames = 4410;
  const stereo = Buffer.allocUnsafe(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44_100) * 10000);
    stereo.writeInt16LE(value, i * 4);
    stereo.writeInt16LE(value, i * 4 + 2);
  }
  const wav = encodeWav(stereo, { sampleRate: 44_100, channels: 2 });
  const line = wavToLineFormat(wav);
  assert.ok(Math.abs(durationSeconds(line) - 0.1) < 0.01);
});

test('a file that is not a wav says so rather than producing noise', () => {
  assert.throws(() => decodeWav(Buffer.from('not a wav at all')), /RIFF/);
});

test('a wav with no data chunk is refused', () => {
  const header = encodeWav(Buffer.alloc(0)).subarray(0, 36);
  const wav = Buffer.concat([header]);
  wav.writeUInt32LE(wav.length - 8, 4);
  assert.throws(() => decodeWav(wav), /data chunk/);
});
