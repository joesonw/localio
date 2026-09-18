import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTwiml, type Twiml } from './parse.js';
import { TwimlExecutor, type ExecutionHost, type RecordRequest, type RecordResult } from './execute.js';

/**
 * A host that records what it was asked to do.
 *
 * The whole point of the executor taking an {@link ExecutionHost} is that this file needs
 * no socket, no database, no clock and no network.
 */
class FakeHost implements ExecutionHost {
  ended = false;
  readonly calls: string[] = [];
  readonly logs: Array<{ kind: string; detail: unknown }> = [];
  /** Documents to hand back, in order, to `fetchDocument`. */
  documents: Array<Twiml | null> = [];
  recordOutcome: RecordResult | null = {
    recordingSid: 'RE1',
    recordingUrl: 'http://x.test/RE1',
    durationSeconds: 3,
    digits: '#',
  };
  audio: Buffer | Error = Buffer.alloc(320);

  log(kind: string, detail: unknown): void {
    this.logs.push({ kind, detail });
  }
  async say(text: string): Promise<void> {
    this.calls.push(`say:${text}`);
  }
  async playPcm(_samples: Buffer, source: string): Promise<void> {
    this.calls.push(`play:${source}`);
  }
  async pause(seconds: number): Promise<void> {
    this.calls.push(`pause:${seconds}`);
  }
  async record(request: RecordRequest): Promise<RecordResult | null> {
    this.calls.push(`record:${request.maxLengthSeconds}:${request.finishOnKey}`);
    return this.recordOutcome;
  }
  async openStream(url: string, parameters: Record<string, string>): Promise<void> {
    this.calls.push(`stream:${url}:${JSON.stringify(parameters)}`);
  }
  async hangup(reason: string): Promise<void> {
    this.calls.push(`hangup:${reason}`);
    this.ended = true;
  }
  async reject(reason: string): Promise<void> {
    this.calls.push(`reject:${reason}`);
    this.ended = true;
  }
  async sendMessage(body: string, to: string | undefined): Promise<void> {
    this.calls.push(`message:${to ?? '-'}:${body}`);
  }
  async fetchDocument(url: string, method: string, extra: Record<string, string>): Promise<Twiml | null> {
    this.calls.push(`fetch:${method}:${url}:${JSON.stringify(extra)}`);
    return this.documents.shift() ?? null;
  }
  async fetchAudio(url: string): Promise<Buffer> {
    this.calls.push(`audio:${url}`);
    if (this.audio instanceof Error) throw this.audio;
    return this.audio;
  }
}

async function run(host: FakeHost, document: string): Promise<void> {
  await new TwimlExecutor(host).run(parseTwiml(document));
}

test('sequential verbs run in order and the document then hangs up', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Say>one</Say><Pause length="2"/><Say>two</Say></Response>');
  assert.deepEqual(host.calls, ['say:one', 'pause:2', 'say:two', 'hangup:twiml_completed']);
});

/** Running off the end of a document hangs up, which is what Twilio does. */
test('a document that runs out ends the call', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Say>bye</Say></Response>');
  assert.ok(host.ended);
});

test('an empty response ends the call rather than erroring', async () => {
  const host = new FakeHost();
  await run(host, '<Response/>');
  assert.deepEqual(host.calls, ['hangup:empty_response']);
  assert.ok(host.logs.some((l) => l.kind === 'twiml'));
});

/** **Terminal**: nothing after `<Hangup>` runs. */
test('Hangup stops the walk', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Say>one</Say><Hangup/><Say>never</Say></Response>');
  assert.deepEqual(host.calls, ['say:one', 'hangup:twiml_hangup']);
});

test('Reject stops the walk and reports its reason', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Reject reason="busy"/><Say>never</Say></Response>');
  assert.deepEqual(host.calls, ['reject:busy']);
});

test('an unknown reject reason falls back rather than passing through', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Reject reason="nonsense"/></Response>');
  assert.deepEqual(host.calls, ['reject:rejected']);
});

/** **Terminal**: the call belongs to the stream, and parameters go over verbatim. */
test('Connect > Stream is terminal and relays parameters verbatim', async () => {
  const host = new FakeHost();
  await run(
    host,
    '<Response><Connect><Stream url="wss://x.test/v1"><Parameter name="agent_id" value="agt_1"/></Stream></Connect><Say>never</Say></Response>',
  );
  assert.deepEqual(host.calls, ['stream:wss://x.test/v1:{"agent_id":"agt_1"}']);
});

/**
 * **An unknown verb is logged and skipped, never fatal.** `<Gather>` is not implemented,
 * and a document that used one should still reach its `<Say>`.
 */
test('an unsupported verb is skipped and the document continues', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Gather numDigits="1"/><Say>after</Say></Response>');
  assert.deepEqual(host.calls, ['say:after', 'hangup:twiml_completed']);
  assert.ok(
    host.logs.some((l) => JSON.stringify(l.detail).includes('Gather')),
    'the skipped verb must be named in the log',
  );
});

test('Record with no action is sequential', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Record maxLength="10" finishOnKey="#"/><Say>after</Say></Response>');
  assert.deepEqual(host.calls, ['record:10:#', 'say:after', 'hangup:twiml_completed']);
});

/** **Record with an action is terminal**: it POSTs and continues in what comes back. */
test('Record with an action fetches the next document and continues in it', async () => {
  const host = new FakeHost();
  host.documents = [parseTwiml('<Response><Say>thanks</Say></Response>')];
  await run(host, '<Response><Record action="/rec"/><Say>never</Say></Response>');
  assert.deepEqual(host.calls, [
    'record:3600:1234567890*#',
    'fetch:POST:/rec:{"RecordingSid":"RE1","RecordingUrl":"http://x.test/RE1","RecordingDuration":"3","Digits":"#"}',
    'say:thanks',
    'hangup:twiml_completed',
  ]);
});

test('a call that ended during Record runs no action', async () => {
  const host = new FakeHost();
  host.recordOutcome = null;
  await run(host, '<Response><Record action="/rec"/><Say>never</Say></Response>');
  assert.deepEqual(host.calls, ['record:3600:1234567890*#']);
});

test('Redirect replaces the document', async () => {
  const host = new FakeHost();
  host.documents = [parseTwiml('<Response><Say>elsewhere</Say></Response>')];
  await run(host, '<Response><Redirect method="GET">/next</Redirect><Say>never</Say></Response>');
  assert.deepEqual(host.calls, ['fetch:GET:/next:{}', 'say:elsewhere', 'hangup:twiml_completed']);
});

test('a redirect that fetched nothing stops the walk', async () => {
  const host = new FakeHost();
  host.documents = [null];
  await run(host, '<Response><Redirect>/next</Redirect><Say>never</Say></Response>');
  assert.deepEqual(host.calls, ['fetch:POST:/next:{}']);
});

/** A `<Redirect>` back at itself is a document that never finishes. */
test('a redirect loop is stopped rather than running forever', async () => {
  const host = new FakeHost();
  const loop = parseTwiml('<Response><Redirect>/self</Redirect></Response>');
  host.documents = Array.from({ length: 50 }, () => loop);
  await run(host, '<Response><Redirect>/self</Redirect></Response>');
  assert.ok(host.calls.includes('hangup:twiml_loop'), 'the loop must be named');
  assert.ok(host.calls.filter((c) => c.startsWith('fetch')).length < 25);
});

test('Play fetches and plays, honouring loop', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Play loop="2">http://x.test/a.wav</Play></Response>');
  assert.deepEqual(host.calls, [
    'audio:http://x.test/a.wav',
    'play:http://x.test/a.wav',
    'play:http://x.test/a.wav',
    'hangup:twiml_completed',
  ]);
});

/** A prompt that would not load is a log line, not a failed call. */
test('a Play whose audio will not load is skipped', async () => {
  const host = new FakeHost();
  host.audio = new Error('404 fetching audio');
  await run(host, '<Response><Play>http://x.test/missing.wav</Play><Say>after</Say></Response>');
  assert.deepEqual(host.calls, ['audio:http://x.test/missing.wav', 'say:after', 'hangup:twiml_completed']);
  assert.ok(host.logs.some((l) => JSON.stringify(l.detail).includes('play_failed')));
});

test('Play with digits synthesises nothing and carries on', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Play digits="ww123"/><Say>after</Say></Response>');
  assert.deepEqual(host.calls, ['say:after', 'hangup:twiml_completed']);
});

test('Say honours loop', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Say loop="3">x</Say></Response>');
  assert.deepEqual(host.calls.slice(0, 3), ['say:x', 'say:x', 'say:x']);
});

/** `loop="0"` is "forever" at Twilio. One pass is the deliberate difference. */
test('Say loop=0 runs once rather than forever', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Say loop="0">x</Say></Response>');
  assert.deepEqual(host.calls, ['say:x', 'hangup:twiml_completed']);
});

test('Message in a voice document sends and continues', async () => {
  const host = new FakeHost();
  await run(host, '<Response><Message to="+15551110000">hi</Message><Hangup/></Response>');
  assert.deepEqual(host.calls, ['message:+15551110000:hi', 'hangup:twiml_hangup']);
});

test('a verb after the call has ended does not run', async () => {
  const host = new FakeHost();
  host.ended = true;
  await run(host, '<Response><Say>one</Say><Say>two</Say></Response>');
  assert.deepEqual(host.calls, []);
});
