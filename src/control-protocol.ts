import { z } from 'zod';

/**
 * The wire between the browser handset and this app.
 *
 * Audio is **binary frames of little-endian PCM16, mono, 8 kHz, in both directions**. It
 * is 8 kHz rather than a negotiated rate because the far end is Twilio's wire, which has
 * no other rate; `AudioContext({ sampleRate: 8000 })` is what makes the browser resample
 * the microphone into it, and `src/g711.ts` is the only other conversion on the live path.
 *
 * Fields are snake_case, as they appear on the wire.
 */

/* ------------------------------------------------------------ browser -> app */

/**
 * Place the call. **Two paths**, and `call_sid` is which one.
 *
 * **Dial in from the handset.** No `call_sid`: the page names the caller as `from` and one
 * of this simulator's numbers as `to`, and the server resolves the account and the signing
 * token from the `phone_numbers` row. **There is no direction on this frame** — the handset
 * *is* the outside world, so a call it originates is `inbound` and nothing else. A call the
 * other way round is not something a browser can choose: it is placed through
 * `POST …/Calls.json` and then *answered* here, which is the second path. Neither an account
 * sid nor a token is ever on this frame either — unlike the app this was extracted from,
 * `localio` holds the credentials itself, so there is nothing for a browser to type and
 * nothing for it to get wrong.
 *
 * **Answer a call the application placed.** `call_sid` names a `CA…` this app's REST API
 * already answered a `Calls.json` with, and it decides the whole call: `from` and `to` are
 * **not read at all**, because the row says who is calling whom. Its direction is
 * `outbound-api` because that is what a REST placement is, and the server sets it. The page
 * still sends the two numbers because the frame requires them, and the server overwrites
 * both.
 *
 * **That `CA…` is adopted, never re-minted.** It is the sid the REST call already
 * answered with, so it has to be the sid on the voice webhook, on the `<Stream>`'s
 * parameters and on the status callback. A second mint anywhere on that path leaves the
 * placement and the conversation as two calls that merely look alike, with nothing
 * anywhere saying so.
 */
const dialSchema = z.object({
  type: z.literal('dial'),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  /** A waiting placed call's `CA…`. Present means the row decides everything above. */
  call_sid: z.string().min(1).max(64).optional(),
  /**
   * Who claimed this call when Pick up was clicked, from `POST /api/calls/:sid/claim`.
   *
   * Only meaningful alongside `call_sid`, and only advisory — it lets the server tell a
   * tab that lost the race before the microphone prompt from the tab that won it. What
   * actually keeps the call single is still `Calls.answer()`.
   */
  holder: z.string().min(1).max(64).optional(),
});

const dtmfSchema = z.object({
  type: z.literal('dtmf'),
  digit: z.string().regex(/^[0-9*#A-D]$/),
});

/**
 * A mark whose audio has now actually been heard.
 *
 * **The browser sends this, not the server**, after the chunk it rode in with has
 * finished playing. Echoing it on receipt would over-report by the whole of the client
 * buffer, and a gateway that truncates a model's history at the last acknowledged mark
 * would then cut it past the moment the caller actually spoke.
 */
const markSchema = z.object({
  type: z.literal('mark'),
  name: z.string().min(1).max(128),
});

const hangupSchema = z.object({ type: z.literal('hangup') });

const controlFrameSchema = z.discriminatedUnion('type', [
  dialSchema,
  dtmfSchema,
  markSchema,
  hangupSchema,
]);

export type DialFrame = z.infer<typeof dialSchema>;
export type ControlFrame = z.infer<typeof controlFrameSchema>;

/** Read one text frame from the page. Never throws; a bad frame is a message to show. */
export function decodeControlFrame(
  text: string,
): ControlFrame | { type: 'invalid'; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { type: 'invalid', message: 'not json' };
  }
  const result = controlFrameSchema.safeParse(parsed);
  return result.success
    ? result.data
    : { type: 'invalid', message: result.error.issues[0]?.message ?? 'unrecognized frame' };
}

/* ------------------------------------------------------------ app -> browser */

export type ControlEvent =
  /**
   * What a webhook answered, **always sent, whatever it was**. A 403, a 404 and a
   * document with nothing in it are the outcomes this app exists to make legible, so
   * none of them may be swallowed into a generic failure.
   */
  | {
      type: 'webhook';
      kind: 'voice' | 'status' | 'action' | 'redirect' | 'recording-status';
      status: number;
      body: string;
      url: string;
    }
  | { type: 'call'; call_sid: string; from: string; to: string; direction: string }
  /** A verb started. The UI draws these as the document being walked. */
  | { type: 'verb'; name: string; detail?: string }
  /** `<Say>`. There is no TTS here, so the text is shown and the line is held. */
  | { type: 'say'; text: string }
  /** `<Play>` — audio is arriving as binary frames behind this. */
  | { type: 'play'; url: string; ms: number }
  | { type: 'recording_started'; sid: string; max_length: number }
  | { type: 'recording_stopped'; sid: string; duration: number; reason: string; url: string }
  | { type: 'connected'; call_sid: string; stream_sid: string; stream_url: string }
  | { type: 'mark'; name: string }
  | { type: 'clear' }
  | { type: 'error'; code: string; message: string }
  | { type: 'closed'; reason: string };

export function encodeControlEvent(event: ControlEvent): string {
  return JSON.stringify(event);
}
