import { attr, boolAttr, numberAttr, parseTwiml, streamParameters, type Twiml, type Verb } from './parse.js';

/**
 * Walking a TwiML document.
 *
 * The app this was extracted from had a *reader*: three regular expressions that told you
 * whether the document was a `<Stream>`, a `<Say>` or a `<Message>`. That was enough while
 * the only real verb was `<Connect><Stream>`. `<Record>` is what makes it not enough — a
 * recording happens in the middle of a call and the document goes on afterwards, so
 * something has to hold a position in a list of verbs.
 *
 * Two kinds of verb, and the difference is the whole design:
 *
 * - **Sequential** — `<Say>`, `<Play>`, `<Pause>`, and `<Record>` with no `action`.
 *   Control comes back and the next verb runs.
 * - **Terminal** — `<Hangup>`, `<Reject>`, `<Connect><Stream>`, `<Redirect>`, and
 *   `<Record>` *with* an `action`. The document ends there. The last two end it by
 *   **replacing** it: they fetch a new document and the walk continues in that one, which
 *   is what makes a recording loop or an IVR possible at all.
 *
 * **An unknown verb is logged and skipped, never fatal.** `<Gather>` and `<Dial>` are not
 * implemented here and will take that path; a document that used one should still get as
 * far as its `<Say>`, and the log should name what was ignored. Refusing the whole
 * document instead would make adding a verb to the application under test look like the
 * simulator crashing.
 *
 * Nothing in this file touches a socket, a database or the clock directly — it is all
 * through {@link ExecutionHost}, which is what lets the whole executor be tested with a
 * host that records what it was asked to do.
 */

export interface RecordRequest {
  maxLengthSeconds: number;
  /** Seconds of silence that end it. Twilio's own default is 5. */
  timeoutSeconds: number;
  /** Any one of these digits ends it. Empty means no key does. */
  finishOnKey: string;
  playBeep: boolean;
  trim: boolean;
  /** Where to report the finished recording, if the verb named somewhere. */
  recordingStatusCallback: string;
}

export interface RecordResult {
  recordingSid: string;
  recordingUrl: string;
  durationSeconds: number;
  /** The key that ended it, `hangup`, or `''` when it simply ran out. */
  digits: string;
}

/** What the executor needs the outside world to be able to do. */
export interface ExecutionHost {
  /** True once the call is over. Every verb checks it; a dead call runs no more document. */
  readonly ended: boolean;

  log(kind: string, detail: unknown): void;

  /** `<Say>`: there is no TTS here. The text is shown, and the line is held for it. */
  say(text: string): Promise<void>;
  /** `<Play>`: 8 kHz mono PCM16, already decoded and resampled. */
  playPcm(samples: Buffer, source: string): Promise<void>;
  pause(seconds: number): Promise<void>;
  record(request: RecordRequest): Promise<RecordResult | null>;
  /** `<Connect><Stream>`. Resolves when the media leg is finished with. */
  openStream(url: string, parameters: Record<string, string>): Promise<void>;
  /** `<Hangup>`, and the end of a document that ran out. */
  hangup(reason: string): Promise<void>;
  /** `<Reject>`: the call never connected, so no status callback is posted. */
  reject(reason: string): Promise<void>;
  /** `<Message>` inside a voice document, and the whole of a messaging one. */
  sendMessage(body: string, to: string | undefined, from: string | undefined): Promise<void>;

  /**
   * Fetch the next document: a `<Redirect>`, or a `<Record action>`.
   *
   * The host owns this rather than the executor because signing it needs the account's
   * token, and **the token never leaves the thing that signs with it**.
   */
  fetchDocument(
    url: string,
    method: 'GET' | 'POST',
    extra: Record<string, string>,
    kind: 'redirect' | 'action',
  ): Promise<Twiml | null>;

  /** `<Play>`'s fetch. Separate from `fetchDocument` because it is not signed and not XML. */
  fetchAudio(url: string): Promise<Buffer>;
}

/** How many documents one call may chain through before this calls it a loop. */
const MAX_DOCUMENTS = 20;

export class TwimlExecutor {
  private documents = 0;

  constructor(private readonly host: ExecutionHost) {}

  /** Run a document. Returns when the call is over or the document has run out. */
  async run(twiml: Twiml): Promise<void> {
    this.documents += 1;
    if (this.documents > MAX_DOCUMENTS) {
      // A `<Redirect>` back at itself is a document that never finishes, and the symptom
      // without this is a call that never ends and a log that scrolls forever.
      this.host.log('error', { code: 'twiml_loop', documents: this.documents });
      await this.host.hangup('twiml_loop');
      return;
    }

    if (twiml.verbs.length === 0) {
      // An empty `<Response/>` is a **result**, not an error. It is what a webhook
      // answers for "nothing to do", and deliberately the same document whether that
      // meant no route, no handler or a turn that failed — which of the three it was
      // lives in the application's own log, and this app must not guess.
      this.host.log('twiml', { verbs: 0, note: 'empty response' });
      await this.host.hangup('empty_response');
      return;
    }

    for (const verb of twiml.verbs) {
      if (this.host.ended) return;
      const next = await this.runVerb(verb);
      if (next === 'stop') return;
      if (next !== 'continue') {
        await this.run(next);
        return;
      }
    }

    if (!this.host.ended) {
      // Running off the end of a document hangs up, which is what Twilio does. A call
      // left open on a document that said nothing more is a call nobody can explain.
      await this.host.hangup('twiml_completed');
    }
  }

  /** `continue` to run the next verb, `stop` to end the walk, or a document to run instead. */
  private async runVerb(verb: Verb): Promise<'continue' | 'stop' | Twiml> {
    switch (verb.name) {
      case 'Say':
        return this.runSay(verb);
      case 'Play':
        return this.runPlay(verb);
      case 'Pause':
        return this.runPause(verb);
      case 'Record':
        return this.runRecord(verb);
      case 'Redirect':
        return this.runRedirect(verb);
      case 'Reject':
        return this.runReject(verb);
      case 'Hangup':
        this.host.log('verb', { verb: 'Hangup' });
        await this.host.hangup('twiml_hangup');
        return 'stop';
      case 'Connect':
        return this.runConnect(verb);
      case 'Message':
        return this.runMessage(verb);
      case 'Stream':
        // A bare `<Stream>` outside `<Connect>` is Twilio's *forked* stream, which
        // listens without taking over the call. Not implemented, and skipping it is
        // right: the call genuinely does carry on.
        this.host.log('verb', { verb: 'Stream', note: 'unsupported outside <Connect>' });
        return 'continue';
      default:
        this.host.log('verb', { verb: verb.name, note: 'unsupported, skipped' });
        return 'continue';
    }
  }

  private async runSay(verb: Verb): Promise<'continue'> {
    const loop = Math.max(1, Math.trunc(numberAttr(verb, 'loop', 1)));
    // `loop="0"` means "until the call ends" at Twilio. Reading it as one pass is the
    // deliberate difference: a simulator that will not stop talking is not usable.
    for (let i = 0; i < loop && !this.host.ended; i += 1) {
      this.host.log('verb', { verb: 'Say', text: verb.text, pass: i + 1 });
      await this.host.say(verb.text);
    }
    return 'continue';
  }

  private async runPlay(verb: Verb): Promise<'continue'> {
    const url = verb.text.trim();
    const digits = attr(verb, 'digits');
    if (digits) {
      // `<Play digits>` plays DTMF tones rather than a file, and has no URL.
      this.host.log('verb', { verb: 'Play', digits, note: 'dtmf tones not synthesised' });
      return 'continue';
    }
    if (!url) {
      this.host.log('verb', { verb: 'Play', note: 'no url' });
      return 'continue';
    }
    let samples: Buffer;
    try {
      samples = await this.host.fetchAudio(url);
    } catch (error) {
      // A prompt that would not load is a line in the log and the call carrying on —
      // the same trade every unsupported verb makes. Failing the call instead would
      // turn a typo in a URL into something that looks like the simulator breaking.
      this.host.log('error', {
        code: 'play_failed',
        url,
        message: error instanceof Error ? error.message : String(error),
      });
      return 'continue';
    }
    const loop = Math.max(1, Math.trunc(numberAttr(verb, 'loop', 1)));
    for (let i = 0; i < loop && !this.host.ended; i += 1) {
      this.host.log('verb', { verb: 'Play', url, bytes: samples.length, pass: i + 1 });
      await this.host.playPcm(samples, url);
    }
    return 'continue';
  }

  private async runPause(verb: Verb): Promise<'continue'> {
    const seconds = Math.max(0, numberAttr(verb, 'length', 1));
    this.host.log('verb', { verb: 'Pause', seconds });
    await this.host.pause(seconds);
    return 'continue';
  }

  private async runRecord(verb: Verb): Promise<'continue' | 'stop' | Twiml> {
    const request: RecordRequest = {
      maxLengthSeconds: Math.max(1, numberAttr(verb, 'maxLength', 3600)),
      timeoutSeconds: Math.max(0, numberAttr(verb, 'timeout', 5)),
      // `finishOnKey` defaults to `1234567890*#` at Twilio, which is every key.
      finishOnKey: attr(verb, 'finishOnKey') ?? '1234567890*#',
      playBeep: boolAttr(verb, 'playBeep', true),
      trim: (attr(verb, 'trim') ?? 'trim-silence') === 'trim-silence',
      recordingStatusCallback: attr(verb, 'recordingStatusCallback') ?? '',
    };
    this.host.log('verb', { verb: 'Record', ...request });

    const result = await this.host.record(request);
    if (result === null || this.host.ended) {
      // The call ended during the recording. Whatever was captured has already been
      // stored by the host; there is simply no one left to run an `action` for.
      return 'stop';
    }

    const action = attr(verb, 'action');
    if (!action) {
      // **Non-terminal only when there is no `action`.** With one, Twilio POSTs and
      // continues in whatever comes back, which is what makes a record-and-review loop
      // expressible at all.
      return 'continue';
    }

    const document = await this.host.fetchDocument(
      action,
      method(attr(verb, 'method')),
      {
        RecordingSid: result.recordingSid,
        RecordingUrl: result.recordingUrl,
        RecordingDuration: String(result.durationSeconds),
        Digits: result.digits,
      },
      'action',
    );
    return document ?? 'stop';
  }

  private async runRedirect(verb: Verb): Promise<'continue' | 'stop' | Twiml> {
    const url = verb.text.trim();
    if (!url) {
      this.host.log('verb', { verb: 'Redirect', note: 'no url' });
      return 'continue';
    }
    this.host.log('verb', { verb: 'Redirect', url });
    const document = await this.host.fetchDocument(url, method(attr(verb, 'method')), {}, 'redirect');
    return document ?? 'stop';
  }

  private async runReject(verb: Verb): Promise<'stop'> {
    // `reason` is `rejected` or `busy`; anything else is Twilio's default.
    const reason = attr(verb, 'reason') === 'busy' ? 'busy' : 'rejected';
    this.host.log('verb', { verb: 'Reject', reason });
    await this.host.reject(reason);
    return 'stop';
  }

  private async runConnect(verb: Verb): Promise<'continue' | 'stop'> {
    const stream = verb.children.find((child) => child.name === 'Stream');
    if (!stream) {
      this.host.log('verb', {
        verb: 'Connect',
        note: `unsupported child ${verb.children[0]?.name ?? 'none'}`,
      });
      return 'continue';
    }
    const url = attr(stream, 'url');
    if (!url) {
      this.host.log('error', { code: 'stream_no_url' });
      return 'continue';
    }
    // Verbatim, with no encoding of any kind. The parser has already undone the one XML
    // layer, and a second would turn a `%2B` into a bare `+` that the far end's query
    // parser reads as a space — which is a caller's number arriving blank and silently.
    const parameters = streamParameters(stream);
    this.host.log('stream', { url, parameters });
    await this.host.openStream(url, parameters);
    // `<Connect>` is terminal: the call belongs to the stream now, and the document
    // resumes at nothing when it ends.
    return 'stop';
  }

  private async runMessage(verb: Verb): Promise<'continue'> {
    // Not trimmed — the whitespace in a reply is part of the reply.
    const body = verb.text;
    this.host.log('verb', { verb: 'Message', length: body.length });
    await this.host.sendMessage(body, attr(verb, 'to'), attr(verb, 'from'));
    return 'continue';
  }
}

function method(raw: string | undefined): 'GET' | 'POST' {
  return (raw ?? 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
}

/** The documents this app emits itself. Four, and all of them for a reason. */
export const TWIML = {
  /** What a webhook that had nothing to say answers. Also what a timeout is rendered as. */
  empty: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
};

export { parseTwiml };
