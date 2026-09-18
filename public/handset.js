import { canPickSpeaker, ensureMicPermission, PlaybackQueue, startCapture } from './audio.js';

/**
 * The handset: a microphone, a speaker and a log, on one WebSocket.
 *
 * **Its element lookups happen inside {@link createHandset}, not at module top.** That is
 * the difference between this and a page script, and it is what makes it safe to build
 * lazily — the page is drawn before anybody has granted a microphone.
 *
 * Two rules about audio on this wire, both inherited and both load-bearing:
 *
 * - **Binary frames are audio, text frames are control.** There is no other framing.
 * - **A mark is echoed after playback, not on receipt.** {@link PlaybackQueue} holds each
 *   mark against the buffer source it rode in with and reports it from `onended`; a
 *   barge-in discards the marks whose audio was dropped. Echoing on arrival would
 *   over-report by the whole of the browser's queue.
 */

export function createHandset({ onLive, onIdle }) {
  const el = {
    mic: document.getElementById('h-mic'),
    speaker: document.getElementById('h-speaker'),
    micLevel: document.getElementById('h-mic-level'),
    spkLevel: document.getElementById('h-spk-level'),
    mute: document.getElementById('h-mute'),
    state: document.getElementById('h-state'),
    log: document.getElementById('h-log'),
  };

  let socket = null;
  let capture = null;
  let playback = null;
  let muted = false;
  let live = false;

  /* ------------------------------------------------------------ the log */

  function log(kind, text, className = '') {
    if (el.log.querySelector('.empty')) el.log.textContent = '';
    const line = document.createElement('div');
    line.className = `log-line ${className}`;
    const when = document.createElement('span');
    when.className = 'log-when';
    when.textContent = new Date().toLocaleTimeString();
    const what = document.createElement('span');
    what.className = 'log-kind';
    what.textContent = kind;
    const body = document.createElement('span');
    body.className = 'log-text';
    // `textContent`, never markup: what arrives here includes a TwiML body from another
    // process and a message body somebody was actually sent. This page has no business
    // parsing either.
    body.textContent = text;
    line.append(when, what, body);
    el.log.append(line);
    el.log.scrollTop = el.log.scrollHeight;
  }

  function clearLog() {
    el.log.innerHTML = '<p class="empty">Nothing yet.</p>';
  }

  function setState(text, className = '') {
    el.state.textContent = text;
    el.state.className = `state ${className}`;
  }

  /* --------------------------------------------------------- the devices */

  async function loadDevices() {
    const permission = await ensureMicPermission();
    if (permission !== 'granted') {
      // Said plainly. Until a page has been granted access a browser will not name the
      // devices, so an empty picker reads as "this app cannot see my microphone" rather
      // than as a prompt that was dismissed.
      log('devices', `microphone ${permission} — the pickers stay empty until it is allowed`, 'error');
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    fill(el.mic, devices.filter((d) => d.kind === 'audioinput'), 'default microphone');
    if (canPickSpeaker()) {
      fill(el.speaker, devices.filter((d) => d.kind === 'audiooutput'), 'default speaker');
    } else {
      el.speaker.innerHTML = '<option>this browser cannot choose an output</option>';
      el.speaker.disabled = true;
    }
  }

  function fill(select, devices, fallback) {
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = fallback;
    select.append(auto);
    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || device.deviceId.slice(0, 12);
      select.append(option);
    }
  }

  /* ------------------------------------------------------------ the call */

  async function dial(frame) {
    if (live) return;
    live = true;
    clearLog();
    setState('dialling', 'live');
    onLive?.();

    playback = new PlaybackQueue(
      () => {
        el.spkLevel.style.width = playback?.speaking ? '100%' : '0';
      },
      (name) => send({ type: 'mark', name }),
    );
    await playback.setSinkId(el.speaker.value);

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/control`);
    socket.binaryType = 'arraybuffer';

    socket.addEventListener('open', async () => {
      send(frame);
      try {
        capture = await startCapture(el.mic.value, ({ audio, rms }) => {
          el.micLevel.style.width = `${Math.min(100, Math.round(rms * 400))}%`;
          // A muted frame has zero length and is sent as such: the server drops it
          // rather than forwarding silence, so the far end sees a real gap.
          if (socket?.readyState === WebSocket.OPEN) socket.send(audio);
        });
        el.mute.disabled = false;
      } catch (error) {
        log('microphone', String(error?.message ?? error), 'error');
      }
    });

    socket.addEventListener('message', (event) => {
      if (event.data instanceof ArrayBuffer) {
        playback?.enqueue(event.data);
        return;
      }
      onEvent(JSON.parse(event.data));
    });

    socket.addEventListener('close', () => teardown('the socket closed'));
    socket.addEventListener('error', () => log('socket', 'the control socket errored', 'error'));
  }

  function onEvent(event) {
    switch (event.type) {
      case 'call':
        setState('ringing', 'live');
        log('call', `${event.call_sid}  ${event.from} → ${event.to}  (${event.direction})`);
        return;
      case 'webhook':
        log(
          `webhook ${event.kind}`,
          `${event.status || 'no response'}  ${event.url}\n${event.body}`,
          event.status >= 200 && event.status < 300 ? '' : 'error',
        );
        return;
      case 'verb':
        log('verb', event.name);
        return;
      case 'say':
        // There is no TTS here. Showing the text *is* `<Say>`.
        log('say', event.text, 'say');
        return;
      case 'play':
        log('play', `${event.url}  (${event.ms} ms)`);
        return;
      case 'recording_started':
        setState('recording', 'live');
        log('record', `started ${event.sid}, up to ${event.max_length}s`);
        return;
      case 'recording_stopped':
        setState('on call', 'live');
        log('record', `${event.sid}  ${event.duration}s  (${event.reason})\n${event.url}`);
        return;
      case 'connected':
        setState('on call', 'live');
        log('stream', `${event.stream_sid} → ${event.stream_url}`);
        return;
      case 'mark':
        // Handed to the queue, not echoed here — see the header.
        playback?.mark(event.name);
        return;
      case 'clear':
        // Barge-in. The marks on the dropped audio go with it.
        playback?.flush();
        log('stream', 'clear (barge-in)');
        return;
      case 'error':
        setState('failed', 'failed');
        log('error', `${event.code}: ${event.message}`, 'error');
        return;
      case 'closed':
        log('end', event.reason);
        return;
      default:
        // Ignored rather than refused, which is the rule on every wire in this app.
        return;
    }
  }

  function send(frame) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function hangup() {
    send({ type: 'hangup' });
    teardown('you hung up');
  }

  /** One teardown, idempotent — the page, the socket and the server all reach it. */
  function teardown(reason) {
    if (!live) return;
    live = false;
    capture?.stop();
    capture = null;
    playback?.close();
    playback = null;
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
    socket = null;
    muted = false;
    el.mute.disabled = true;
    el.mute.textContent = 'Mute';
    el.micLevel.style.width = '0';
    el.spkLevel.style.width = '0';
    if (el.state.className.includes('failed')) {
      el.state.textContent = 'failed';
    } else {
      setState('idle');
    }
    log('end', reason);
    onIdle?.();
  }

  /* -------------------------------------------------------------- wiring */

  el.mute.addEventListener('click', () => {
    muted = !muted;
    capture?.setMuted(muted);
    el.mute.textContent = muted ? 'Unmute' : 'Mute';
  });

  el.speaker.addEventListener('change', () => void playback?.setSinkId(el.speaker.value));

  void loadDevices();

  /**
   * A keypad press, on a call that is up.
   *
   * The keypad belongs to the page, not to this module: the same buttons compose a number
   * when nothing is dialled and send tones when something is, and only the page knows
   * which. Pressing a key with no call is not an error, it is just not a tone.
   */
  function dtmf(digit) {
    if (!live) return;
    send({ type: 'dtmf', digit });
    log('dtmf', digit);
  }

  return { dial, hangup, dtmf, get live() { return live; } };
}
