import { z } from 'zod';

/**
 * Twilio Media Streams, written from the provider's end.
 *
 * The whole point of this app is to be an independent thing arriving at the application
 * under test's door, so nothing here is shared with a decoder — a shared package would
 * let a bug in the codec agree with itself. Two field placements are easy to get
 * backwards: `streamSid` is **top-level** on `start` while `callSid` is nested inside it,
 * and `dtmf` carries `digit` singular where most gateways say `digits`.
 *
 * The wire carries **no binary frames in either direction**. Everything is a JSON text
 * frame and audio rides inside it as base64.
 */

/** What the far end sends back. Only three events; everything else is dropped before here. */
const mediaSchema = z.object({
  event: z.literal('media'),
  media: z.object({ payload: z.string() }),
});

const markSchema = z.object({
  event: z.literal('mark'),
  mark: z.object({ name: z.string().min(1) }),
});

const clearSchema = z.object({ event: z.literal('clear') });

const outboundSchema = z.discriminatedUnion('event', [mediaSchema, markSchema, clearSchema]);

export type GatewayFrame = z.infer<typeof outboundSchema> | { event: 'unknown' };

/**
 * Read one frame from the far end.
 *
 * **Cannot throw and cannot fail**: anything unrecognised is `unknown` and is ignored by
 * the caller. Ending a live call over a frame nobody was going to read is by far the
 * worse failure, and it is the rule a real adapter holds itself to in the other
 * direction.
 */
export function decodeGatewayFrame(text: string): GatewayFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { event: 'unknown' };
  }
  const result = outboundSchema.safeParse(parsed);
  return result.success ? result.data : { event: 'unknown' };
}

/** The handshake frame, sent the instant the socket opens. Carries no `streamSid` yet. */
export function encodeConnected(): string {
  return JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });
}

/**
 * Which call this is, at the provider.
 *
 * Named rather than spelled `Omit<StartFacts, 'streamSid'>`: a stop frame has no business
 * carrying the parameters a stream *opened* with, and the subtraction would quietly
 * oblige it to every time `StartFacts` grows a field.
 */
export interface CallIds {
  callSid: string;
  accountSid: string;
}

export interface StartFacts extends CallIds {
  streamSid: string;
  /**
   * What the `<Connect><Stream>`'s `<Parameter>` children said, handed straight back.
   *
   * **This is often what makes the far end able to route the call at all** — an agent id,
   * a session id, a direction. A gateway that refuses a stream whose parameters name no
   * agent will refuse this one too, which is exactly what a real Twilio does with a
   * document that carried none.
   *
   * Verbatim, with no encoding of any kind: a real provider echoes the values it was
   * given, and the TwiML parser has already undone the one XML layer between them.
   */
  customParameters: Record<string, string>;
}

/**
 * `start` — the frame that gives the far end a `streamSid` to address its own output
 * with, and the one it usually arms a watchdog against.
 *
 * Everything the real thing sends is here even where a given gateway reads two fields,
 * because the point of this app is to be what a provider sends rather than the minimum
 * that happens to work today.
 */
export function encodeStart(facts: StartFacts): string {
  return JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    // Top-level, and *also* inside `start` — which is what Twilio does. The adapter
    // reads the top-level one.
    streamSid: facts.streamSid,
    start: {
      streamSid: facts.streamSid,
      accountSid: facts.accountSid,
      callSid: facts.callSid,
      // Inside `start`, which is where Twilio puts it and where the adapter reads it.
      customParameters: facts.customParameters,
      tracks: ['inbound'],
      mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
    },
  });
}

/** The caller's audio, µ-law, base64 inside the envelope. */
export function encodeMedia(streamSid: string, audio: Buffer): string {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: audio.toString('base64') },
  });
}

/** A keypad press. `digit`, singular — that is Twilio's spelling, whatever the far end calls it. */
export function encodeDtmf(streamSid: string, digit: string): string {
  return JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit } });
}

/** A mark the gateway pushed, echoed back once its audio has actually been played. */
export function encodeMark(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

/** The caller hung up. The far end reads this as a hangup at any point in the session. */
export function encodeStop(streamSid: string, facts: CallIds): string {
  return JSON.stringify({
    event: 'stop',
    streamSid,
    stop: { accountSid: facts.accountSid, callSid: facts.callSid },
  });
}

/** The base64 payload of a gateway `media` frame, as bytes. */
export function decodeAudio(payload: string): Buffer {
  return Buffer.from(payload, 'base64');
}
