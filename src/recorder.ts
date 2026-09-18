import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { durationSeconds, encodeWav, SAMPLE_RATE } from './wav.js';

/**
 * `<Record>`, from the provider's side.
 *
 * A recording at Twilio is the **caller's** audio for as long as the verb is running.
 * Here the caller is a browser tab, so this is simply the inbound PCM16 frames, buffered
 * while the verb is active and written to a WAV when it stops. There is no encoding step:
 * the live path is already 16-bit PCM at 8 kHz mono, which is exactly what a WAV holds.
 *
 * **Four ways it stops, and which one it was is part of the answer.** `maxLength` running
 * out, a `finishOnKey` digit, `timeout` seconds of silence, or the call ending under it.
 * Twilio reports the third and fourth differently — a key press comes back on the
 * `action` request as `Digits`, a hangup as the literal `hangup` — so this keeps them
 * apart rather than reporting "it stopped".
 *
 * The silence detector is RMS against a fixed floor. It is crude and it is honest about
 * being crude: a real one would track a noise floor, and the difference on a browser
 * microphone in a quiet room is nothing. What it must not do is fire on the *first*
 * frames, before anybody has said anything — hence {@link Recorder.heard}.
 */

/** Below this RMS a frame counts as silence. 8-bit-ish noise on a live mic sits well under it. */
const SILENCE_RMS = 500;

export type StopReason = 'max-length' | 'finish-key' | 'silence' | 'hangup' | 'stopped';

export interface RecorderOptions {
  sid: string;
  dir: string;
  maxLengthSeconds: number;
  timeoutSeconds: number;
  finishOnKey: string;
  trim: boolean;
}

export interface RecordingOutcome {
  sid: string;
  path: string;
  durationSeconds: number;
  reason: StopReason;
  /** The key that ended it, `hangup`, or `''`. What Twilio puts in `Digits`. */
  digits: string;
}

export class Recorder {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private readonly maxBytes: number;
  /** Consecutive silent bytes, reset by anything audible. The silence timer. */
  private silentBytes = 0;
  /** Nothing counts as silence until something has been audible. See the header. */
  private heard = false;
  private stopped: RecordingOutcome | null = null;
  private reason: StopReason | null = null;
  private digits = '';

  constructor(private readonly options: RecorderOptions) {
    this.maxBytes = Math.floor(options.maxLengthSeconds * SAMPLE_RATE) * 2;
  }

  get done(): boolean {
    return this.reason !== null;
  }

  /**
   * Feed one frame of inbound audio.
   *
   * Returns the reason it ended, if this frame ended it. The caller stops feeding at that
   * point; a frame arriving afterwards is dropped rather than throwing, because the
   * socket and the verb do not stop at the same instant.
   */
  write(pcm: Buffer): StopReason | null {
    if (this.reason !== null) return null;

    // Trimmed to the remaining budget rather than rejected: `maxLength` is a duration,
    // and a frame that straddles it contributes the part that fits.
    const room = this.maxBytes - this.bytes;
    const frame = pcm.length > room ? pcm.subarray(0, room) : pcm;
    if (frame.length > 0) {
      this.chunks.push(Buffer.from(frame));
      this.bytes += frame.length;
      if (rms(frame) >= SILENCE_RMS) {
        this.heard = true;
        this.silentBytes = 0;
      } else if (this.heard) {
        this.silentBytes += frame.length;
      }
    }

    if (this.bytes >= this.maxBytes) return this.finish('max-length', '');
    if (
      this.options.timeoutSeconds > 0 &&
      this.silentBytes >= this.options.timeoutSeconds * SAMPLE_RATE * 2
    ) {
      return this.finish('silence', '');
    }
    return null;
  }

  /** A keypad press. Ends the recording when it is one of `finishOnKey`. */
  dtmf(digit: string): StopReason | null {
    if (this.reason !== null) return null;
    if (!this.options.finishOnKey.includes(digit)) return null;
    return this.finish('finish-key', digit);
  }

  /** The call ended under the verb. Twilio reports this as `Digits=hangup`. */
  hangup(): StopReason | null {
    if (this.reason !== null) return null;
    return this.finish('hangup', 'hangup');
  }

  /** Stopped for any other reason — the socket closing, the process shutting down. */
  abort(): StopReason | null {
    if (this.reason !== null) return null;
    return this.finish('stopped', '');
  }

  private finish(reason: StopReason, digits: string): StopReason {
    this.reason = reason;
    this.digits = digits;
    return reason;
  }

  /**
   * Write the WAV and describe what was captured. Idempotent — teardown has several
   * entrances, and two files for one recording would be two `RE…` that are not.
   */
  save(): RecordingOutcome {
    if (this.stopped) return this.stopped;
    if (this.reason === null) this.finish('stopped', '');

    let samples: Buffer = Buffer.concat(this.chunks);
    if (this.options.trim) samples = trimSilence(samples);

    const path = join(this.options.dir, `${this.options.sid}.wav`);
    writeFileSync(path, encodeWav(samples));
    this.stopped = {
      sid: this.options.sid,
      path,
      // Rounded rather than truncated: Twilio reports whole seconds, and a 0.9-second
      // recording reported as `0` reads as one that failed.
      durationSeconds: Math.round(durationSeconds(samples)),
      reason: this.reason ?? 'stopped',
      digits: this.digits,
    };
    return this.stopped;
  }
}

function rms(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const value = pcm.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Drop the silence at each end, in 20 ms windows.
 *
 * Windowed rather than per-sample because speech crosses zero constantly — a per-sample
 * test would cut the recording at the first zero crossing, which is about a hundred times
 * a second.
 */
function trimSilence(pcm: Buffer): Buffer {
  const window = (SAMPLE_RATE / 50) * 2;
  let start = 0;
  let end = pcm.length;
  while (start + window <= end && rms(pcm.subarray(start, start + window)) < SILENCE_RMS) {
    start += window;
  }
  while (end - window >= start && rms(pcm.subarray(end - window, end)) < SILENCE_RMS) {
    end -= window;
  }
  return pcm.subarray(start, end);
}
