/**
 * The microphone and the speaker, for the handset.
 *
 * **A port, not a fresh derivation.** The capture worklet, the graph and the playback
 * scheduler below were kept because they are correct, and the accounting in
 * {@link PlaybackQueue} in particular is load-bearing — read its own doc before touching
 * it.
 *
 * **Everything here is 8 kHz, and there is no resampler.** The far end of this handset is
 * Twilio's wire, which has one codec and one rate. `AudioContext` takes a `sampleRate`,
 * so asking for 8000 makes the browser resample the microphone on the way in and the
 * speaker on the way out — which is the whole reason the server needs no resampling code
 * on the live path either.
 */

/** Twilio's only rate. Both directions, both contexts. */
export const SAMPLE_RATE = 8000;

/**
 * The capture worklet, as source.
 *
 * In a `Blob` URL rather than a file of its own because a worklet is loaded by URL at
 * runtime rather than imported — and this app has no bundler to turn a second file into
 * an asset. It does the whole float-to-PCM16 conversion on the audio thread and hands the
 * main thread finished frames plus a level, so the main thread never touches a sample.
 */
const captureWorklet = `
  class CaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.chunk = options.processorOptions.chunk;
      this.buffer = new Int16Array(this.chunk);
      this.filled = 0;
      this.energy = 0;
    }

    process(inputs) {
      const input = inputs[0];
      const channel = input === undefined ? undefined : input[0];
      if (channel === undefined) {
        return true;
      }

      for (let i = 0; i < channel.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this.buffer[this.filled] = Math.round(sample * 32767);
        this.energy += sample * sample;
        this.filled += 1;

        if (this.filled === this.chunk) {
          const frame = this.buffer.slice();
          const rms = Math.sqrt(this.energy / this.chunk);
          this.port.postMessage({ audio: frame.buffer, rms }, [frame.buffer]);
          this.filled = 0;
          this.energy = 0;
        }
      }

      return true;
    }
  }

  registerProcessor('capture', CaptureProcessor);
`;

/**
 * Ask for the microphone, so that the device lists are worth showing.
 *
 * **This has to happen before `enumerateDevices`, and that is the whole reason it exists.**
 * Until a page has been granted access a browser will not tell it what devices there are:
 * Chromium answers with a single placeholder per kind carrying an empty `label` *and* an
 * empty `deviceId`, and the others do something equally useless. So a picker built before
 * the prompt is not merely unlabelled — it is empty, which reads as "this app cannot see my
 * devices" rather than as a prompt that never happened.
 *
 * Three things about how it asks:
 *
 * - **No `deviceId` constraint.** What is wanted here is the permission, not a particular
 *   microphone; an `exact` constraint could fail for a reason that has nothing to do with
 *   being allowed, and the page would then report the wrong problem.
 * - **Every track is stopped immediately.** A probe that keeps its stream leaves the
 *   browser's recording indicator lit for the whole session and can hold the device
 *   exclusively — so the real {@link startCapture} at dial time would be competing with it.
 * - **A rejection is one answer.** Dismissed and refused are the same thing to this page,
 *   and no browser lets it act on the difference.
 */
export async function ensureMicPermission() {
  // `navigator.mediaDevices` is undefined outside a secure context, and that is a state
  // to expect rather than a theoretical one: widen `LOCALIO_HOST` and this page is
  // reached over plain http at a LAN address. Answering rather than throwing keeps a
  // `TypeError` here from stopping the page's whole start-up.
  if (navigator.mediaDevices === undefined) {
    return 'unavailable';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

/**
 * Whether this browser lets a page choose the output device at all.
 *
 * `AudioContext.setSinkId` is Chromium 110+; Firefox and Safari have no output picker, and
 * their speaker list is empty for the same reason. Tested on the prototype so the page can
 * say so at load rather than constructing a context purely to ask — which is what made the
 * answer arrive only at dial time before.
 */
export function canPickSpeaker() {
  return (
    typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function'
  );
}

/**
 * Open the microphone and start producing PCM16 frames at 8 kHz.
 *
 * `onFrame` is called fifty times a second from the audio thread's message port, so it
 * must not do anything expensive — the page throttles the level and puts the bytes
 * straight on the socket.
 */
export async function startCapture(deviceId, onFrame) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });

  let muted = false;
  let stopped = false;

  // Asking for 8000 is what makes the browser resample for us.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const moduleUrl = URL.createObjectURL(
    new Blob([captureWorklet], { type: 'application/javascript' }),
  );

  try {
    await ctx.audioWorklet.addModule(moduleUrl);
    await ctx.resume();
  } catch (error) {
    URL.revokeObjectURL(moduleUrl);
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await ctx.close();
    throw error;
  }

  // 160 samples: 20 ms at 8 kHz, which is exactly Twilio's framing. So a frame from
  // this worklet becomes one `media` event with no re-chunking anywhere in between.
  const node = new AudioWorkletNode(ctx, 'capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { chunk: SAMPLE_RATE / 50 },
  });

  node.port.onmessage = (event) => {
    if (muted) {
      // Dropped rather than sent as silence, so the far end's turn detection sees a
      // real gap. The level still goes through as zero, so the meter reads as muted.
      onFrame({ audio: new ArrayBuffer(0), rms: 0 });
      return;
    }
    onFrame(event.data);
  };

  // A silent sink. The worklet emits nothing, but a node not reachable from the
  // destination is not guaranteed to be pulled at all.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);

  const source = ctx.createMediaStreamSource(stream);
  source.connect(node);

  return {
    setMuted(next) {
      muted = next;
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      node.port.onmessage = null;
      node.disconnect();
      sink.disconnect();
      source.disconnect();
      for (const track of stream.getTracks()) {
        track.stop();
      }
      URL.revokeObjectURL(moduleUrl);
      void ctx.close();
    },
  };
}

/**
 * Agent audio, played in order.
 *
 * Chunks arrive faster than they play, so each is scheduled after the last rather than
 * started on arrival — otherwise they overlap and the agent sounds like a crowd.
 *
 * **This class also decides when a mark has been heard**, which is the one thing here
 * that is not a straight port. A mark rides behind a chunk of audio; the gateway's
 * playback ledger is only honest if it is echoed once that chunk has actually come out of
 * the speaker, so it is attached to the buffer source and reported from `onended`.
 * Echoing on arrival would over-report by the whole of this queue, and an interrupt would
 * then cut the agent's history at a point the caller never reached.
 *
 * **A mark attaches to the chunk already scheduled, never to the next one.** The gateway
 * sends one mark after each chunk, so the last mark of an utterance has no chunk
 * following it — holding marks for the *next* `enqueue` would leave that one unreported
 * for ever, and `playbackIdle` on the gateway side could then never become true. An agent
 * hanging up would fall back to its drain deadline on every call and close blind to what
 * was actually heard, cutting the farewell off. Real Twilio echoes that trailing mark,
 * and so must this.
 */
export class PlaybackQueue {
  constructor(onChange, onMarkPlayed) {
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.playing = new Set();
    this.nextAt = 0;
    this.onChange = onChange;
    this.onMarkPlayed = onMarkPlayed;
    /**
     * The mark array of the last chunk scheduled, or `null` when nothing is queued.
     * A mark arriving now belongs behind that chunk, which is the one it rode in after.
     */
    this.tailMarks = null;
  }

  get speaking() {
    return this.playing.size > 0;
  }

  /** Pick an output device, where the browser supports one. */
  async setSinkId(deviceId) {
    if (!deviceId || typeof this.ctx.setSinkId !== 'function') {
      return false;
    }
    try {
      await this.ctx.setSinkId(deviceId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A mark the gateway sent.
   *
   * It rides behind the audio already sent, so it is attached to the chunk most recently
   * scheduled and reported when that chunk ends.
   */
  mark(name) {
    if (this.tailMarks === null) {
      // Nothing is queued, so the audio this mark rode behind has already been heard.
      this.onMarkPlayed(name);
      return;
    }
    this.tailMarks.push(name);
  }

  enqueue(chunk) {
    if (chunk.byteLength < 2) {
      return;
    }

    const pcm = new Int16Array(chunk, 0, Math.floor(chunk.byteLength / 2));
    const frame = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    const channel = frame.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) {
      channel[i] = (pcm[i] ?? 0) / 32768;
    }

    const node = this.ctx.createBufferSource();
    node.buffer = frame;
    node.connect(this.ctx.destination);

    const at = Math.max(this.ctx.currentTime, this.nextAt);
    node.start(at);
    this.nextAt = at + frame.duration;

    // This chunk is now the one a mark arriving next rides behind.
    const marks = [];
    this.tailMarks = marks;

    this.playing.add(node);
    node.onended = () => {
      this.playing.delete(node);
      // Only if nothing has been scheduled behind it since; otherwise a later chunk owns
      // the tail and a mark arriving now still belongs to that one.
      if (this.tailMarks === marks) {
        this.tailMarks = null;
      }
      for (const name of marks) {
        this.onMarkPlayed(name);
      }
      this.onChange();
    };
    this.onChange();
  }

  /**
   * Drop everything still queued. Barge-in.
   *
   * The marks waiting on dropped audio are **discarded, not reported**: their chunks were
   * never heard, and telling the gateway otherwise would move the truncation point past
   * the moment the caller actually interrupted — which is the exact bug the ledger exists
   * to avoid.
   */
  flush() {
    for (const node of this.playing) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already finished between the iteration and the call.
      }
    }
    this.playing.clear();
    this.tailMarks = null;
    this.nextAt = 0;
    this.onChange();
  }

  close() {
    this.flush();
    void this.ctx.close();
  }
}
