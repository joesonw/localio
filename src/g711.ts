/**
 * G.711 µ-law, and nothing else.
 *
 * **Pure on purpose**, exactly as `twilio-envelope.ts` is: no socket, no
 * logger, no session, so every rule in it is asserted by a test that runs in a
 * millisecond. That matters here because this codec fails *quietly* — a sign error or an
 * off-by-one in the segment table does not throw, it produces audio that is merely wrong,
 * and "the agent sounds like static" is a long way from the line that caused it.
 *
 * This is the whole of the transcoding in this app, and it is deliberately the whole of
 * it. Twilio's wire is 8 kHz mono µ-law; the browser sends 8 kHz mono PCM16 because
 * `AudioContext({ sampleRate: 8000 })` makes it resample the microphone natively. So the
 * rate already agrees at both edges and **there is no resampler here** — the same fact the
 * `start` frame's `mediaFormat` records on the other side of the wire.
 */

/** µ-law's zero. `wav.ts` writes the same byte for silence. */
export const MULAW_SILENCE = 0xff;

/**
 * Where the magnitude clamps, and the bias added before the exponent is found.
 *
 * `32635` rather than a round `32767`: the bias is added *after* clipping, and the sum
 * has to stay inside fifteen bits for the exponent search below to terminate on the
 * right segment. Clipping to the wrong value is the classic way to write this codec
 * wrongly — it does not throw, it quietly crushes everything loud into the top segment,
 * which sounds like the agent shouting through a blown speaker.
 */
const MULAW_CLIP = 32635;
const MULAW_BIAS = 0x84;

/**
 * One PCM16 sample as one µ-law byte.
 *
 * The textbook implementation, kept in the textbook's shape rather than table-driven:
 * the table is thirteen lines of magic numbers that cannot be read against the standard,
 * and this runs 160 times per 20 ms frame, which is not a place that needs the speed.
 */
function encodeSample(sample: number): number {
  // The sign is taken and removed first; everything below works on a magnitude.
  let value = sample;
  const sign = value < 0 ? 0x80 : 0x00;
  if (value < 0) {
    value = -value;
  }
  // `-32768` has no positive counterpart in a 16-bit signed integer, so the negation
  // above leaves it negative. Clamping catches that as well as genuine overload.
  if (value > MULAW_CLIP) {
    value = MULAW_CLIP;
  }
  value += MULAW_BIAS;

  // The exponent is the position of the highest set bit above the bias.
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  // Inverted, which is what makes silence `0xff` rather than `0x00`.
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One µ-law byte back to a PCM16 sample. Exact — the loss all happened on the way in. */
function decodeSample(byte: number): number {
  const value = ~byte & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  const magnitude = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign !== 0 ? -magnitude : magnitude;
}

/**
 * Little-endian PCM16 to µ-law: **one byte out per sample in**, which is why
 * a gateway counting bytes on this transport is counting samples.
 *
 * An odd trailing byte is dropped rather than padded. It cannot happen — the browser
 * sends whole 160-sample frames — and half a sample is not a sample.
 */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const samples = pcm.length >> 1;
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = encodeSample(pcm.readInt16LE(i * 2));
  }
  return out;
}

/** µ-law back to little-endian PCM16, two bytes out per byte in. */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i += 1) {
    out.writeInt16LE(decodeSample(mulaw[i] ?? MULAW_SILENCE), i * 2);
  }
  return out;
}
