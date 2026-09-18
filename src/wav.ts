import { mulawToPcm16 } from './g711.js';

/**
 * WAV, the two directions this app needs.
 *
 * `<Record>` **writes** one: 16-bit PCM, 8 kHz, mono, which is the rate the whole live
 * path already runs at, so writing is a header in front of the samples and nothing else.
 * `<Play>` **reads** one, and that is where the work is — the file on the far end of a
 * `<Play url>` is whatever the developer put there, so this accepts 8-bit PCM, 16-bit
 * PCM and µ-law, mono or stereo, at any rate, and hands back 8 kHz mono PCM16.
 *
 * **This is the one resampler in the app, and it exists only for `<Play>`.** The live
 * path has none and must not grow one: `AudioContext({ sampleRate: 8000 })` makes the
 * browser resample the microphone natively in both directions, which is why `g711.ts` is
 * the whole of the transcoding there. A file read off disk has no browser to do that for
 * it, so it is resampled here, once, on the way in.
 *
 * MP3 is not read and not written. A `<Play>` pointed at one is reported as an
 * unsupported media type rather than decoded badly, and a recording is offered as the WAV
 * it actually is rather than under an `.mp3` name that would make every client's decoder
 * the one to complain.
 */

/** Everything on the live path, and every recording written. */
export const SAMPLE_RATE = 8000;

const FORMAT_PCM = 1;
const FORMAT_MULAW = 7;

export interface Pcm {
  samples: Buffer;
  sampleRate: number;
  channels: number;
}

/**
 * A 16-bit PCM mono WAV, header and all.
 *
 * The canonical 44-byte header: `RIFF`, `WAVE`, a 16-byte `fmt ` chunk and a `data`
 * chunk. Nothing extra — an extensible header would be more correct and is read by fewer
 * things, and a recording exists to be opened.
 */
export function encodeWav(
  samples: Buffer,
  options: { sampleRate?: number; channels?: number } = {},
): Buffer {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const channels = options.channels ?? 1;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  // The RIFF size counts everything after this field, which is the header's last 36
  // bytes plus the audio — not the file, and not the audio alone.
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(FORMAT_PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/**
 * Read a WAV into PCM16.
 *
 * **Chunks are walked rather than assumed at fixed offsets.** A file written by anything
 * other than this module may carry a `LIST` or a `fact` chunk between `fmt ` and `data`,
 * and reading `data` at byte 44 regardless is the classic way to play a file that is
 * three seconds of noise followed by the audio.
 *
 * Throws on a file this cannot read, with a message naming what it was — a `<Play>` that
 * failed should say the format, not just fail.
 */
export function decodeWav(buffer: Buffer): Pcm {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a RIFF file');
  }
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAVE file');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === 'fmt ' && body.length >= 16) {
      format = body.readUInt16LE(0);
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bitsPerSample = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    // Chunks are word-aligned: an odd size is followed by one pad byte that is not
    // counted in it. Skipping that byte leaves every subsequent chunk id misread.
    offset += 8 + size + (size % 2);
  }

  if (!data) throw new Error('no data chunk');
  if (channels < 1) throw new Error('no fmt chunk');

  let samples: Buffer;
  if (format === FORMAT_MULAW) {
    samples = mulawToPcm16(data);
  } else if (format === FORMAT_PCM && bitsPerSample === 16) {
    samples = data;
  } else if (format === FORMAT_PCM && bitsPerSample === 8) {
    // 8-bit PCM in a WAV is *unsigned*, centred on 128 — the one place in this file
    // where the obvious reading is the wrong one.
    samples = Buffer.allocUnsafe(data.length * 2);
    for (let i = 0; i < data.length; i += 1) {
      samples.writeInt16LE(((data[i] ?? 128) - 128) * 256, i * 2);
    }
  } else {
    throw new Error(`unsupported wav format ${format} at ${bitsPerSample} bits`);
  }

  return { samples, sampleRate, channels };
}

/** Average the channels down to one. Stereo at the far end of a `<Play>` is common. */
export function toMono(pcm: Pcm): Pcm {
  if (pcm.channels <= 1) return pcm;
  const frames = Math.floor(pcm.samples.length / 2 / pcm.channels);
  const out = Buffer.allocUnsafe(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < pcm.channels; channel += 1) {
      sum += pcm.samples.readInt16LE((frame * pcm.channels + channel) * 2);
    }
    out.writeInt16LE(Math.round(sum / pcm.channels), frame * 2);
  }
  return { samples: out, sampleRate: pcm.sampleRate, channels: 1 };
}

/**
 * Linear interpolation between neighbouring samples.
 *
 * Not a good resampler — there is no anti-aliasing filter, so downsampling folds anything
 * above 4 kHz back into the band as a faint whistle. That is the right trade for a
 * simulator playing a prompt at a developer: a proper polyphase filter is a hundred lines
 * and the audible difference on speech is very small. Do not reach for this on the live
 * path, which has no resampler at all and does not need one.
 */
export function resample(pcm: Pcm, targetRate = SAMPLE_RATE): Pcm {
  if (pcm.sampleRate === targetRate || pcm.sampleRate <= 0) {
    return { ...pcm, sampleRate: targetRate };
  }
  const input = pcm.samples.length / 2;
  const ratio = targetRate / pcm.sampleRate;
  const output = Math.max(1, Math.floor(input * ratio));
  const out = Buffer.allocUnsafe(output * 2);
  for (let i = 0; i < output; i += 1) {
    const position = i / ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input - 1);
    const fraction = position - left;
    const a = pcm.samples.readInt16LE(left * 2);
    const b = pcm.samples.readInt16LE(right * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))), i * 2);
  }
  return { samples: out, sampleRate: targetRate, channels: 1 };
}

/** The whole of the `<Play>` path: whatever the file was, to what the wire takes. */
export function wavToLineFormat(buffer: Buffer): Buffer {
  return resample(toMono(decodeWav(buffer)), SAMPLE_RATE).samples;
}

/** How long a run of 8 kHz mono PCM16 lasts, in seconds. */
export function durationSeconds(samples: Buffer, sampleRate = SAMPLE_RATE): number {
  return samples.length / 2 / sampleRate;
}
