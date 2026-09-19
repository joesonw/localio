import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket } from 'ws';
import { CallClaims } from './call-claims.js';
import type { CallFeed } from './call-feed.js';
import { postCallStatus, type CallEventName, type CallStatusDeps } from './call-status.js';
import type { Config } from './config.js';
import {
  encodeControlEvent,
  type ControlEvent,
  type DialFrame,
} from './control-protocol.js';
import type { Account, PhoneNumber, Store } from './db/index.js';
import { mulawToPcm16, pcm16ToMulaw } from './g711.js';
import { providerId } from './provider-id.js';
import { Recorder } from './recorder.js';
import type { SmsService } from './sms.js';
import {
  decodeAudio,
  decodeGatewayFrame,
  encodeConnected,
  encodeDtmf,
  encodeMark,
  encodeMedia,
  encodeStart,
  encodeStop,
} from './twilio-envelope.js';
import { parseTwiml, type Twiml } from './twiml/parse.js';
import {
  TwimlExecutor,
  type ExecutionHost,
  type RecordRequest,
  type RecordResult,
} from './twiml/execute.js';
import { SAMPLE_RATE, wavToLineFormat } from './wav.js';
import {
  recordingForm,
  voiceForm,
  type CallFacts,
  type WebhookPoster,
} from './webhook.js';

/**
 * One browser socket, one call.
 *
 * This is the provider's side of a phone call: it posts the voice webhook, reads the
 * TwiML that comes back, walks it, and — for `<Connect><Stream>` — opens the media socket
 * and sits between the browser's PCM16 and the far end's µ-law.
 *
 * Three rules here are the ones that fail silently when broken, and each is marked at its
 * site below:
 *
 * - **A placed call's `CA…` is adopted, never re-minted.** The REST API already answered
 *   with it.
 * - **A mark is echoed after playback, not on receipt.** The browser sends it back; this
 *   only forwards.
 * - **Teardown is one idempotent path**, and the status callback is posted from it — only
 *   for a call that actually got somewhere. A webhook that answered 403 was never a call
 *   at Twilio either.
 */

export interface CallSessionOptions {
  store: Store;
  poster: WebhookPoster;
  /** So a `<Message>` in a voice document is delivered rather than merely stored. */
  sms: SmsService;
  config: Config;
  logger: Logger;
  client: WebSocket;
  claims: CallClaims;
  feed: CallFeed;
  onClosed: (session: CallSession) => void;
}

/** 20 ms of 8 kHz mono PCM16 — the frame size the whole live path uses. */
const FRAME_BYTES = (SAMPLE_RATE / 50) * 2;

export class CallSession implements ExecutionHost {
  private readonly store: Store;
  private readonly poster: WebhookPoster;
  private readonly sms: SmsService;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly client: WebSocket;
  private readonly claims: CallClaims;
  private readonly feed: CallFeed;
  private readonly onClosed: (session: CallSession) => void;

  private callSid = '';
  private accountSid = '';
  private authToken = '';
  private from = '';
  private to = '';
  private direction: 'inbound' | 'outbound-api' = 'inbound';
  private ourNumber: PhoneNumber | null = null;

  private gateway: WebSocket | null = null;
  private streamSid = '';
  private streamClosed: (() => void) | null = null;

  private recorder: Recorder | null = null;
  private recorderDone: ((outcome: RecordResult | null) => void) | null = null;

  private connected = false;
  private closed = false;
  /**
   * Set when this session took a *queued* row, so `dial()` can report `ringing`.
   *
   * Only a placed call has that transition: an inbound one is created `ringing` and is
   * `in-progress` on the next line, because the handset dialling *is* the call arriving.
   */
  private ringingPending = false;
  private finalStatus: 'completed' | 'busy' | 'no-answer' | 'failed' = 'completed';

  constructor(options: CallSessionOptions) {
    this.store = options.store;
    this.poster = options.poster;
    this.sms = options.sms;
    this.config = options.config;
    this.logger = options.logger;
    this.client = options.client;
    this.claims = options.claims;
    this.feed = options.feed;
    this.onClosed = options.onClosed;
  }

  get ended(): boolean {
    return this.closed;
  }

  get sid(): string {
    return this.callSid;
  }

  /* ------------------------------------------------------------------ dialling */

  /**
   * Start the call.
   *
   * **Two paths**, and `call_sid` is which. Answering a call the application *placed*
   * adopts the row wholesale — the sid, both numbers, the direction and the answer URL —
   * because a REST placement already decided every one of them and was already told the
   * sid. Dialling out from the handset resolves the number instead: whichever of `From` /
   * `To` is ours names the row, and the row names the account and the token.
   */
  async dial(frame: DialFrame): Promise<void> {
    if (frame.call_sid !== undefined) {
      if (!(await this.answerPlacedCall(frame.call_sid, frame.holder))) return;
    } else if (!this.startNewCall(frame)) {
      return;
    }

    this.send({
      type: 'call',
      call_sid: this.callSid,
      from: this.from,
      to: this.to,
      direction: this.direction,
    });

    // After `resolveAccount`, which is what put a token in hand to sign with.
    if (this.ringingPending) {
      this.ringingPending = false;
      await this.progress('ringing', 'ringing');
    }

    const inline = this.answerTwiml();
    const answerUrl = inline ? '' : this.answerUrl();
    if (!inline && !answerUrl) {
      this.fail(
        'no_voice_url',
        `${this.ourNumber?.phoneNumber ?? 'that number'} has no voice_url — set one in the Numbers panel`,
      );
      return;
    }

    // Inline TwiML is presented as a webhook that answered 200, because to everything
    // downstream — the executor, the event log, the page — that is exactly what it is.
    // The alternative is a second shape of "where the document came from" threaded
    // through all three.
    const result = inline
      ? { status: 200, body: inline, url: 'twiml:inline', params: {}, method: 'POST' as const, durationMs: 0 }
      : await this.poster.post(
          answerUrl,
          this.authToken,
          voiceForm(this.facts()),
          this.voiceMethod(),
          { kind: 'voice', callSid: this.callSid },
        );
    this.store.calls.log(this.callSid, 'webhook', {
      kind: 'voice',
      status: result.status,
      url: result.url,
      body: result.body,
    });
    this.send({
      type: 'webhook',
      kind: 'voice',
      status: result.status,
      body: result.body,
      url: result.url,
    });

    if (result.status < 200 || result.status >= 300) {
      // A 403 is almost always a token the application does not agree with; a 404 is a
      // route it does not have. Both are shown rather than folded into "the call
      // failed", because those are the two outcomes this simulator exists to make
      // legible — and neither posts a status callback, because neither was a call.
      this.finalStatus = 'failed';
      await this.end(`the voice webhook answered ${result.status || 'nothing'}`);
      return;
    }

    let twiml: Twiml;
    try {
      twiml = parseTwiml(result.body);
    } catch (error) {
      this.finalStatus = 'failed';
      this.fail('bad_twiml', error instanceof Error ? error.message : String(error));
      return;
    }

    this.store.calls.markInProgress(this.callSid);
    await this.progress('answered', 'in-progress');
    this.store.calls.log(this.callSid, 'twiml', { verbs: twiml.verbs.map((v) => v.name) });
    // The call has reached a document, which is the point past which a status callback is
    // owed — see `end`.
    this.connected = true;
    await new TwimlExecutor(this).run(twiml);
  }

  /**
   * Take a queued call, **once**.
   *
   * `Calls.answer` is a conditional update, so a second tab gets `null` rather than a
   * second call. **The `CA…` is adopted, not minted** — the REST placement was already
   * answered with it, so it has to be the sid on the voice webhook, in the `<Stream>`'s
   * parameters and on the status callback. A second mint here leaves the placement and
   * the conversation as two calls that merely look alike, with nothing saying so.
   *
   * The direction is `outbound-api` because that is what a REST placement is, and it is
   * not the page's to choose: an application reads it to decide that **`From`** is the
   * number of its own that the call went out on.
   */
  private async answerPlacedCall(sid: string, holder?: string): Promise<boolean> {
    // The claim the page took when Pick up was clicked, checked before anything is spent.
    // Its only job is to name the tab that lost *early*; `Calls.answer()` below is still
    // what makes this happen once. A dial with no holder claims under an id of its own, so
    // an older page cannot barge a call somebody is already picking up.
    // Not a sid — `provider-id.ts` mints Twilio's shapes and this is nobody's identifier
    // but this one socket's, for the length of one pickup.
    const claimant = holder ?? randomUUID();
    if (!this.claims.claim(sid, claimant)) {
      this.fail('call_claimed', 'another tab is picking that call up');
      return false;
    }
    const call = this.store.calls.answer(sid);
    // Held only across the gap: past this line the row is no longer `queued`, so the
    // conditional UPDATE is the guard and the claim has nothing left to protect.
    this.claims.release(sid, claimant);
    if (call === null) {
      this.fail(
        'no_such_placed_call',
        'that call is not waiting to be answered any more — another tab may have taken it, or it was declined',
      );
      return false;
    }
    // The authoritative moment: the row has left `queued` and no other tab can have it.
    // Every other page drops the row on this frame instead of on its next poll — advisory
    // still, because the conditional UPDATE above is what actually decided it.
    this.feed.publish({ kind: 'taken', call, claimedBy: null });
    this.callSid = call.sid;
    this.ringingPending = true;
    this.from = call.from;
    this.to = call.to;
    this.direction = 'outbound-api';
    // Our number is the one the call went out *on*, which is `From` for an outbound call.
    this.ourNumber = this.store.numbers.findByNumber(call.from);
    const account = this.store.accounts.find(call.accountSid);
    if (!this.resolveAccount(account)) return false;
    return true;
  }

  /**
   * Dial in from the handset: one of our numbers is on the call, and it decides everything.
   *
   * **Always `inbound`**, which is the initialized value and is not the page's to choose.
   * The handset is the outside world; a call it originates is somebody ringing one of our
   * numbers. A call the other way round is placed through `POST …/Calls.json` and reaches
   * this class through {@link answerPlacedCall} instead.
   */
  private startNewCall(frame: DialFrame): boolean {
    this.from = frame.from;
    this.to = frame.to;

    // Our number is the one being rung, which is `To` for an inbound call. That is the same
    // rule a real application applies when it resolves a webhook back to its own number.
    const row = this.store.numbers.findByNumber(frame.to);
    if (row === null) {
      this.fail(
        'no_such_number',
        `${frame.to} is not a number this simulator holds — add it in the Numbers panel`,
      );
      return false;
    }
    this.ourNumber = row;
    if (!this.resolveAccount(this.store.accounts.find(row.accountSid))) return false;

    const call = this.store.calls.create({
      accountSid: this.accountSid,
      from: this.from,
      to: this.to,
      direction: this.direction,
      status: 'ringing',
    });
    this.callSid = call.sid;
    this.store.calls.markInProgress(call.sid);
    return true;
  }

  private resolveAccount(account: Account | null): boolean {
    if (account === null) {
      this.fail('no_such_account', 'the account holding that number no longer exists');
      return false;
    }
    this.accountSid = account.accountSid;
    this.authToken = account.authToken;
    if (this.authToken === '') {
      this.fail('no_auth_token', `account ${account.accountSid} has a blank auth token`);
      return false;
    }
    return true;
  }

  /**
   * Where the voice webhook goes.
   *
   * A **placed** call is answered at the URL the placement named, taken verbatim — that
   * is what a real provider does, and it matters because an application puts its own
   * routing on that URL's query string. Answering at the number's standing `voice_url`
   * instead would quietly route a call placed for one destination to whatever the number
   * is configured for, and nothing anywhere would say so.
   */
  private answerUrl(): string {
    const call = this.store.calls.find(this.callSid);
    return call?.answerUrl || this.ourNumber?.voiceUrl || '';
  }

  /**
   * Inline TwiML from the placement, if it named any.
   *
   * Twilio's `Calls.json` takes `Twiml` *instead of* `Url`, and applications under test
   * reach for it constantly because it needs no server. It short-circuits the whole
   * webhook: there is nothing to post to and nothing to sign, so the document is simply
   * the one that was handed over.
   */
  private answerTwiml(): string {
    return this.store.calls.find(this.callSid)?.answerTwiml ?? '';
  }

  /** The placement's `Method`, falling back to the number's standing `voice_method`. */
  private voiceMethod(): 'GET' | 'POST' {
    const call = this.store.calls.find(this.callSid);
    // The call row first: a placed call's `From` may be a number this simulator does not
    // hold, in which case there is no `ourNumber` to read a method off at all.
    const raw = call?.answerUrl ? call.answerMethod : (this.ourNumber?.voiceMethod ?? 'POST');
    return raw === 'GET' ? 'GET' : 'POST';
  }

  private facts(): CallFacts {
    return {
      callSid: this.callSid,
      accountSid: this.accountSid,
      from: this.from,
      to: this.to,
      direction: this.direction,
    };
  }

  private statusDeps(): CallStatusDeps {
    return { store: this.store, poster: this.poster, logger: this.logger };
  }

  /**
   * Report one call-progress event, if the placement asked for it.
   *
   * The row is read back rather than held, because `statusCallbackEvents` and the
   * sequence counter both live on it and both are written elsewhere. `postCallStatus`
   * decides whether anything is actually sent.
   */
  private async progress(event: CallEventName, status: string): Promise<void> {
    if (!this.callSid) return;
    const call = this.store.calls.find(this.callSid);
    if (call === null) return;
    await postCallStatus(this.statusDeps(), {
      call,
      event,
      status,
      authToken: this.authToken,
      fallbackUrl: this.ourNumber?.statusCallbackUrl ?? null,
    });
  }

  /* -------------------------------------------------------- the execution host */

  log(kind: string, detail: unknown): void {
    if (this.callSid === '') return;
    this.store.calls.log(this.callSid, kind, detail);
    if (kind === 'verb') {
      const record = detail as { verb?: string };
      this.send({ type: 'verb', name: record.verb ?? '?', detail: JSON.stringify(detail) });
    }
  }

  /**
   * `<Say>`: the text, and a pause about as long as saying it would take.
   *
   * There is no TTS here and there should not be — synthesising speech would mean a model
   * or a binary, and what a developer needs from `<Say>` in a simulator is to *see that
   * it happened* and in what order. The line is still held for a plausible duration,
   * because a document whose `<Say>`s take no time at all does not exercise anything
   * about timing.
   */
  async say(text: string): Promise<void> {
    this.send({ type: 'say', text });
    // About three words a second, floored at half a second so an empty one is still visible.
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    await this.pause(Math.max(0.5, words / 3));
  }

  /** `<Play>`: real audio, paced in real time so the browser hears it as a call would. */
  async playPcm(samples: Buffer, source: string): Promise<void> {
    const ms = Math.round((samples.length / 2 / SAMPLE_RATE) * 1000);
    this.send({ type: 'play', url: source, ms });
    for (let offset = 0; offset < samples.length; offset += FRAME_BYTES) {
      if (this.closed || this.client.readyState !== WebSocket.OPEN) return;
      this.client.send(samples.subarray(offset, offset + FRAME_BYTES));
      // Paced rather than flushed: a whole prompt sent at once arrives as one burst the
      // browser plays instantly, and a `<Record>` after it would then be recording over
      // audio the caller is still hearing.
      await sleep(20);
    }
  }

  async pause(seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !this.closed) {
      await sleep(Math.min(100, deadline - Date.now()));
    }
  }

  /**
   * `<Record>`: buffer the caller's audio until something stops it.
   *
   * The `RE…` is minted before the audio is written so the file can be named after it,
   * and the row is inserted only once there is a file — a recording row pointing at
   * nothing is worse than no row.
   *
   * Returns `null` when the call ended under the verb: the audio is still saved, but
   * there is nobody left to run an `action` for.
   */
  async record(request: RecordRequest): Promise<RecordResult | null> {
    if (this.closed) return null;
    const sid = this.store.recordings.mint();
    this.recordingStatusUrl = request.recordingStatusCallback;
    if (request.playBeep) {
      // A beep is what tells the person to start talking, and its absence is the first
      // thing a developer notices. 400 ms at 1 kHz, as a real one roughly is.
      await this.playPcm(tone(1000, 0.4), 'beep');
    }

    const recorder = new Recorder({
      sid,
      dir: this.config.recordingsDir,
      maxLengthSeconds: request.maxLengthSeconds,
      timeoutSeconds: request.timeoutSeconds,
      finishOnKey: request.finishOnKey,
      trim: request.trim,
    });
    this.recorder = recorder;
    this.send({ type: 'recording_started', sid, max_length: request.maxLengthSeconds });

    const outcome = await new Promise<RecordResult | null>((resolve) => {
      this.recorderDone = resolve;
      // `maxLength` has to be a timer as well as a byte count: a caller who stops sending
      // audio entirely — a muted microphone, a stalled socket — produces no frame to
      // notice the limit on, and the verb would otherwise never return.
      const timer = setTimeout(
        () => this.finishRecording(),
        (request.maxLengthSeconds + 1) * 1000,
      );
      const original = this.recorderDone;
      this.recorderDone = (result) => {
        clearTimeout(timer);
        original?.(result);
      };
    });
    this.recorder = null;
    this.recorderDone = null;
    return outcome;
  }

  /** Close the recorder, write the file, insert the row. Idempotent; teardown also calls it. */
  private finishRecording(): void {
    const recorder = this.recorder;
    const done = this.recorderDone;
    if (recorder === null || done === null) return;
    this.recorder = null;
    this.recorderDone = null;

    const saved = recorder.save();
    this.store.recordings.create({
      sid: saved.sid,
      callSid: this.callSid,
      accountSid: this.accountSid,
      path: saved.path,
      durationSec: saved.durationSeconds,
    });
    const url = this.recordingUrl(saved.sid);
    this.store.calls.log(this.callSid, 'recording', {
      sid: saved.sid,
      seconds: saved.durationSeconds,
      reason: saved.reason,
    });
    this.send({
      type: 'recording_stopped',
      sid: saved.sid,
      duration: saved.durationSeconds,
      reason: saved.reason,
      url,
    });

    const result: RecordResult = {
      recordingSid: saved.sid,
      recordingUrl: url,
      durationSeconds: saved.durationSeconds,
      digits: saved.digits,
    };
    // Fire-and-forget: `recordingStatusCallback` is a notification, and an application
    // that is slow to acknowledge it must not hold up the `action` request behind it.
    void this.postRecordingStatus(result);
    done(saved.reason === 'hangup' || this.closed ? null : result);
  }

  private async postRecordingStatus(result: RecordResult): Promise<void> {
    const url = this.recordingStatusUrl;
    this.recordingStatusUrl = '';
    if (!url) return;
    const answer = await this.poster.post(
      this.absolute(url),
      this.authToken,
      recordingForm(this.facts(), {
        recordingSid: result.recordingSid,
        recordingUrl: result.recordingUrl,
        durationSeconds: result.durationSeconds,
      }),
      'POST',
      { kind: 'recording-status', callSid: this.callSid },
    );
    this.store.calls.log(this.callSid, 'webhook', {
      kind: 'recording-status',
      status: answer.status,
      url: answer.url,
    });
    this.send({
      type: 'webhook',
      kind: 'recording-status',
      status: answer.status,
      body: answer.body,
      url: answer.url,
    });
  }

  /**
   * Where the application will fetch a recording.
   *
   * Built from `PUBLIC_URL` rather than from the request that produced it: this
   * URL is handed to a *different* process, which may not be able to reach this one at
   * the address a browser used.
   */
  private recordingUrl(sid: string): string {
    return `${this.config.publicUrl}/2010-04-01/Accounts/${this.accountSid}/Recordings/${sid}`;
  }

  /** The `<Record>`'s `recordingStatusCallback`, for as long as that verb is running. */
  private recordingStatusUrl = '';

  async fetchDocument(
    url: string,
    method: 'GET' | 'POST',
    extra: Record<string, string>,
    kind: 'redirect' | 'action',
  ): Promise<Twiml | null> {
    const absolute = this.absolute(url);
    const result = await this.poster.post(
      absolute,
      this.authToken,
      { ...voiceForm(this.facts(), 'in-progress'), ...extra },
      method,
      { kind, callSid: this.callSid },
    );
    this.store.calls.log(this.callSid, 'webhook', {
      kind,
      status: result.status,
      url: result.url,
      body: result.body,
    });
    this.send({
      type: 'webhook',
      kind,
      status: result.status,
      body: result.body,
      url: result.url,
    });
    if (result.status < 200 || result.status >= 300) {
      this.finalStatus = 'failed';
      await this.end(`${kind} answered ${result.status || 'nothing'}`);
      return null;
    }
    try {
      return parseTwiml(result.body);
    } catch (error) {
      this.finalStatus = 'failed';
      this.fail('bad_twiml', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** `<Play>` and a relative `action` may both be site-relative, as at Twilio. */
  private absolute(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    const base = this.answerUrl();
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

  async fetchAudio(url: string): Promise<Buffer> {
    const response = await fetch(this.absolute(url), {
      signal: AbortSignal.timeout(this.config.webhookTimeoutMs),
    });
    if (!response.ok) throw new Error(`${response.status} fetching audio`);
    const type = response.headers.get('content-type') ?? '';
    if (/mpeg|mp3/i.test(type)) {
      // Said plainly rather than decoded badly. There is no MP3 decoder here and adding
      // one would be a dependency for a simulator's prompt audio.
      throw new Error('mp3 is not supported; serve a wav');
    }
    return wavToLineFormat(Buffer.from(await response.arrayBuffer()));
  }

  /**
   * `<Message>` inside a *voice* document: an SMS sent during a call.
   *
   * **Delivered, not merely recorded.** It goes through the same {@link SmsService} a
   * `POST …/Messages.json` does, so it reaches the destination's `sms_url` and can be
   * replied to — which is what Twilio does with it, and what the identical verb in a
   * *messaging* document here already did. Writing the row directly, as this used to,
   * made the same TwiML mean two different things depending on which kind of document it
   * arrived in, with nothing saying so.
   *
   * Defaults are Twilio's: to the other party, from the number the call is on.
   */
  async sendMessage(body: string, to: string | undefined, from: string | undefined): Promise<void> {
    const target = to ?? (this.direction === 'inbound' ? this.from : this.to);
    const sender = from ?? (this.ourNumber?.phoneNumber ?? this.to);
    const result = await this.sms.send({
      from: sender,
      to: target,
      body,
      accountSid: this.accountSid,
      direction: 'outbound-reply',
    });
    this.store.calls.log(this.callSid, 'verb', {
      verb: 'Message',
      messageSid: result.message.sid,
      to: target,
      status: result.message.status,
      note: result.note,
    });
  }

  async hangup(reason: string): Promise<void> {
    await this.end(reason);
  }

  /**
   * `<Reject>`: the call is refused before it ever connects.
   *
   * The status callback **is** posted, carrying `busy` or `no-answer`. That is Twilio's
   * behaviour and the reverse of what this used to do: a refused call is an outcome an
   * application needs to hear about, and it is exactly the outcome it cannot observe any
   * other way.
   */
  async reject(reason: string): Promise<void> {
    this.connected = false;
    this.finalStatus = reason === 'busy' ? 'busy' : 'no-answer';
    await this.end(`rejected: ${reason}`);
  }

  /* -------------------------------------------------------------- the media leg */

  /**
   * Dial the URL the TwiML named, start the stream, and hold until it closes.
   *
   * `STREAM_URL_OVERRIDE` replaces the **origin only**: the path, the query and
   * the `<Parameter>` children are the document's. `parameters` is relayed **verbatim**
   * into the `start` frame — rebuilding or amending it would make this app a second thing
   * deciding what the far end is told about a call, and the two would eventually
   * disagree.
   */
  async openStream(url: string, parameters: Record<string, string>): Promise<void> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      this.fail('bad_stream_url', `the TwiML named a url that is not one: ${url}`);
      return;
    }

    const override = this.config.streamUrlOverride.trim();
    if (override !== '') {
      try {
        const replacement = new URL(override);
        target.protocol = replacement.protocol;
        target.host = replacement.host;
      } catch {
        this.fail('bad_override', 'STREAM_URL_OVERRIDE is not a url');
        return;
      }
    }

    this.streamSid = providerId('MZ');
    const gateway = new WebSocket(target.toString());
    this.gateway = gateway;

    await new Promise<void>((resolve) => {
      this.streamClosed = resolve;

      gateway.on('open', () => {
        // `connected` then `start`, in that order and immediately: the far end holds
        // this socket until `start` arrives — that frame is where the call's parameters
        // are — and typically gives up on a watchdog if it never does.
        gateway.send(encodeConnected());
        gateway.send(
          encodeStart({
            streamSid: this.streamSid,
            callSid: this.callSid,
            accountSid: this.accountSid,
            customParameters: parameters,
          }),
        );
        this.send({
          type: 'connected',
          call_sid: this.callSid,
          stream_sid: this.streamSid,
          stream_url: target.toString(),
        });
      });

      gateway.on('message', (data: Buffer, isBinary: boolean) => {
        // This wire carries no binary in either direction.
        if (!isBinary) this.onGatewayFrame(data.toString());
      });

      gateway.on('error', (error: Error) => {
        this.send({ type: 'error', code: 'gateway_error', message: error.message });
      });

      gateway.on('close', () => {
        // Under `<Connect><Stream>` the socket closing *is* the call ending — there is no
        // frame for it on this wire — so this is the ordinary path, not a failure.
        this.resolveStream();
        void this.end('the far end closed the media stream');
      });
    });
  }

  private resolveStream(): void {
    const resolve = this.streamClosed;
    this.streamClosed = null;
    resolve?.();
  }

  private onGatewayFrame(text: string): void {
    const frame = decodeGatewayFrame(text);
    switch (frame.event) {
      case 'media':
        // µ-law back to PCM16 for a browser that only speaks the latter.
        if (this.client.readyState === WebSocket.OPEN) {
          this.client.send(mulawToPcm16(decodeAudio(frame.media.payload)));
        }
        return;
      case 'mark':
        // **Forwarded, not echoed.** The page sends it back once it has actually played
        // the audio this mark rode behind. Echoing here would over-report by the whole of
        // the browser's buffer.
        this.send({ type: 'mark', name: frame.mark.name });
        return;
      case 'clear':
        this.send({ type: 'clear' });
        return;
      default:
        // Ignored rather than refused: a live call must not end over a frame nobody reads.
        return;
    }
  }

  /* ------------------------------------------------------------- from the page */

  /** The caller's microphone. Into the recorder when one is running, else onto the wire. */
  audio(pcm: Buffer): void {
    if (pcm.length === 0) {
      // A muted frame. Dropped rather than sent as silence, so the far end's turn
      // detection sees a real gap — the same choice the capture worklet makes.
      return;
    }
    const recorder = this.recorder;
    if (recorder !== null) {
      if (recorder.write(pcm) !== null) this.finishRecording();
      return;
    }
    const gateway = this.gateway;
    if (gateway === null || gateway.readyState !== WebSocket.OPEN || this.streamSid === '') {
      return;
    }
    gateway.send(encodeMedia(this.streamSid, pcm16ToMulaw(pcm)));
  }

  dtmf(digit: string): void {
    this.store.calls.log(this.callSid, 'dtmf', { digit });
    const recorder = this.recorder;
    if (recorder !== null && recorder.dtmf(digit) !== null) {
      this.finishRecording();
      return;
    }
    this.toGateway(encodeDtmf(this.streamSid, digit));
  }

  /** A mark the page has now finished playing. The only honest playback accounting. */
  mark(name: string): void {
    this.toGateway(encodeMark(this.streamSid, name));
  }

  hangupFromPage(): void {
    this.toGateway(
      encodeStop(this.streamSid, { callSid: this.callSid, accountSid: this.accountSid }),
    );
    void this.end('the caller hung up');
  }

  private toGateway(frame: string): void {
    const gateway = this.gateway;
    if (gateway !== null && gateway.readyState === WebSocket.OPEN && this.streamSid !== '') {
      gateway.send(frame);
    }
  }

  private fail(code: string, message: string): void {
    if (this.callSid !== '') this.store.calls.log(this.callSid, 'error', { code, message });
    this.send({ type: 'error', code, message });
    this.finalStatus = 'failed';
    void this.end(code);
  }

  private send(event: ControlEvent): void {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(encodeControlEvent(event));
    }
  }

  /* ---------------------------------------------------------------- one teardown */

  /**
   * The single close path, idempotent.
   *
   * The page hanging up, either socket closing, a `<Hangup>`, a `<Reject>`, a webhook
   * that never answered and a document that ran out all land here. A second way to finish
   * a call is a call that either never posts its status callback or posts it twice.
   *
   * **The `completed` callback is posted for every call that ended**, whatever it ended
   * as — `completed`, `busy`, `no-answer` or `failed` — because that is what Twilio does
   * and because `CallStatus` on it already says which. It used to be withheld from any
   * call that never reached a document, on the reasoning that nothing had connected; the
   * cost was that an application waiting on the callback to release a seat or stop a
   * timer waited forever, with "nothing arrived" indistinguishable from "still up".
   *
   * It is still gated on the placement's `StatusCallbackEvent` set, which defaults to
   * `completed` — so an application that asked for nothing in particular sees exactly
   * this one callback, as before.
   */
  async end(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // A recording open at teardown is still saved — the audio was captured, and losing
    // it because the caller hung up is losing exactly the recording most worth having.
    const recorder = this.recorder;
    if (recorder !== null) {
      recorder.hangup();
      this.finishRecording();
    }

    const gateway = this.gateway;
    this.gateway = null;
    if (gateway !== null && gateway.readyState === WebSocket.OPEN) gateway.close();
    this.resolveStream();

    const call = this.callSid ? this.store.calls.finish(this.callSid, this.finalStatus) : null;

    if (call !== null) {
      // **Posted for every call that ended, not only for one that connected.** Twilio
      // sends a completed-call callback for `busy`, `no-answer`, `canceled` and `failed`
      // too — an application waiting on one to release a seat, stop a timer or bill a
      // leg waits forever otherwise, and "nothing arrived" is indistinguishable from
      // "the call is still up". The `CallStatus` on it says which of those it was.
      const answer = await postCallStatus(this.statusDeps(), {
        call,
        event: 'completed',
        status: this.finalStatus,
        authToken: this.authToken,
        fallbackUrl: this.ourNumber?.statusCallbackUrl ?? null,
        durationSeconds: call.durationSec ?? 0,
      });
      if (answer !== null) {
        this.send({
          type: 'webhook',
          kind: 'status',
          status: answer.status,
          body: answer.body,
          url: answer.url,
        });
      }
    }

    if (this.callSid) this.store.calls.log(this.callSid, 'end', { reason, status: this.finalStatus });
    this.logger.info({ callSid: this.callSid, reason }, 'a simulated call ended');
    this.send({ type: 'closed', reason });
    // Cleared rather than merely going out of scope: this object outlives the call by
    // however long the page keeps its socket open.
    this.authToken = '';
    this.onClosed(this);
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** A sine at `hz` for `seconds`, as 8 kHz mono PCM16. The `<Record>` beep, and nothing else. */
function tone(hz: number, seconds: number): Buffer {
  const samples = Math.floor(SAMPLE_RATE * seconds);
  const out = Buffer.allocUnsafe(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 8000), i * 2);
  }
  return out;
}
