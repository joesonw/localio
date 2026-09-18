import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MULAW_SILENCE, mulawToPcm16, pcm16ToMulaw } from './g711.js';

/**
 * µ-law fails **quietly**. A sign error or an off-by-one in the segment table does not
 * throw; it produces audio that is merely wrong, and "the agent sounds like static" is a
 * long way from the line that caused it. So every rule in the codec has a test that runs
 * in a millisecond.
 */

function pcm(...samples: number[]): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((sample, index) => out.writeInt16LE(sample, index * 2));
  return out;
}

function roundTrip(sample: number): number {
  return mulawToPcm16(pcm16ToMulaw(pcm(sample))).readInt16LE(0);
}

/** Silence is `0xff`, not `0x00` — the encoding is inverted, which is easy to miss. */
test('silence encodes to 0xff', () => {
  assert.equal(pcm16ToMulaw(pcm(0))[0], MULAW_SILENCE);
});

test('one byte out per sample in, two bytes back', () => {
  const samples = pcm(0, 1000, -1000, 32767);
  const mulaw = pcm16ToMulaw(samples);
  assert.equal(mulaw.length, 4);
  assert.equal(mulawToPcm16(mulaw).length, 8);
});

test('the sign survives the round trip', () => {
  for (const sample of [100, 1000, 8000, 20000, -100, -1000, -8000, -20000]) {
    const back = roundTrip(sample);
    assert.equal(Math.sign(back), Math.sign(sample), `sign flipped for ${sample}`);
  }
});

/**
 * µ-law is lossy by design — roughly 12 bits of dynamic range in 8 — so the test is that
 * the error stays proportional rather than that the sample comes back exactly.
 */
test('the round trip stays within µ-law quantisation error', () => {
  for (let sample = -32000; sample <= 32000; sample += 317) {
    const back = roundTrip(sample);
    const tolerance = Math.max(64, Math.abs(sample) * 0.08);
    assert.ok(
      Math.abs(back - sample) <= tolerance,
      `${sample} came back as ${back}, outside ±${Math.round(tolerance)}`,
    );
  }
});

/**
 * **The clip is `32635`.** Not `0x1fff` and not `32767`: the bias is added *after*
 * clipping, and the sum has to stay inside fifteen bits for the exponent search to land
 * on the right segment. Getting it wrong crushes everything loud into the top segment —
 * silently, and it sounds like a blown speaker.
 */
test('full scale clips to the top segment rather than wrapping', () => {
  const top = pcm16ToMulaw(pcm(32767))[0];
  const clip = pcm16ToMulaw(pcm(32635))[0];
  assert.equal(top, clip, 'full scale must encode as the clip value');
  assert.ok(roundTrip(32767) > 30000, 'full scale must decode back as loud, not wrapped');
});

/** `-32768` has no positive counterpart, so negating it leaves it negative. */
test('the most negative sample does not wrap to positive', () => {
  const back = roundTrip(-32768);
  assert.ok(back < -30000, `-32768 came back as ${back}`);
});

test('an odd trailing byte is dropped rather than read as half a sample', () => {
  assert.equal(pcm16ToMulaw(Buffer.from([0x01, 0x02, 0x03])).length, 1);
});

test('an empty buffer round trips to empty', () => {
  assert.equal(pcm16ToMulaw(Buffer.alloc(0)).length, 0);
  assert.equal(mulawToPcm16(Buffer.alloc(0)).length, 0);
});
