import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import { CallSession } from './call.js';
import { CallClaims } from './call-claims.js';
import { CallFeed } from './call-feed.js';
import type { Config } from './config.js';
import { decodeControlFrame, encodeControlEvent } from './control-protocol.js';
import type { Store } from './db/index.js';
import { registerAdmin } from './routes/admin.js';
import { registerApp } from './routes/app.js';
import { registerTwilioApi } from './routes/twilio-api.js';
import { SmsService } from './sms.js';
import { WebhookPoster } from './webhook.js';

/**
 * The server: four route families and one WebSocket.
 *
 * **Registration order is load-bearing.** `@fastify/static` serves `public/` at `/` and
 * the Twilio API's `501` catch-all matches `/2010-04-01/*`; both are wildcards, and the
 * catch-all has to be registered after every real `/2010-04-01` route or it would swallow
 * them. That is why `registerTwilioApi` does its own ordering internally and is called
 * before static rather than after.
 *
 * `@fastify/formbody` is not optional and its absence is silent in the worst way: without
 * it every form-encoded POST — which is every route a Twilio client calls — answers 415,
 * and an SDK reports that as a Twilio outage.
 */

export interface ServerOptions {
  store: Store;
  config: Config;
  logger: Logger;
}

export class LocalioServer {
  readonly app: FastifyInstance;
  private readonly sessions = new Set<CallSession>();
  /**
   * Who is mid-pickup, so a second tab can be told before it spends a microphone prompt.
   * Advisory and TTL'd — `Calls.answer()` is what actually keeps a call single.
   */
  private readonly claims = new CallClaims();
  /**
   * Open `/api/calls/stream` responses, so a pending call's arrival and its pickup reach
   * the page now rather than on its next poll. Advisory in the same way the claim is.
   */
  readonly feed = new CallFeed();

  constructor(private readonly options: ServerOptions) {
    const { store, config, logger } = options;

    // `logger as FastifyBaseLogger`: passing a concrete pino `Logger` narrows Fastify's
    // own logger generic, and every route handler below would then be typed against that
    // narrowed instance rather than the plain one. The two are structurally the same
    // logger.
    this.app = Fastify({
      loggerInstance: logger as FastifyBaseLogger,
      // Off because this app's own event log is the interesting record of a call, and a
      // line per poll of the history panel buries it. Fastify 5 deprecates this in favour
      // of a `logController` instance; that API is not usable from a plain object, so
      // this stays until Fastify 6 forces the change.
      //
      // Which is also why the one access log worth having is hand-rolled and scoped:
      // `registerTwilioApi` logs `/2010-04-01` and only `/2010-04-01`, so the requests an
      // application actually made stay legible while the UI's polling stays silent.
      disableRequestLogging: true,
    });
    const poster = new WebhookPoster({ timeoutMs: config.webhookTimeoutMs, logger });
    const sms = new SmsService({ store, poster, config, logger });
    const liveCallSids = () => new Set([...this.sessions].map((s) => s.sid).filter(Boolean));

    void this.app.register(formbody);
    void this.app.register(websocket);

    void this.app.register(async (instance) => {
      registerAdmin(instance, store);
      registerApp(instance, { store, sms, config, liveCallSids, claims: this.claims, feed: this.feed });
      // Registers its own `501` catch-all last, internally. See the header.
      registerTwilioApi(instance, { store, sms, config, logger, liveCallSids, feed: this.feed });
      this.registerControl(instance, poster);
    });

    void this.app.register(fastifyStatic, {
      // Resolved against this module rather than the working directory, so `tsx src/…`
      // and `node dist/…` both find it — `dist/` mirrors `src/`, one level down.
      root: fileURLToPath(new URL('../public', import.meta.url)),
      index: ['index.html'],
    });
  }

  /**
   * The handset socket.
   *
   * One socket, one call: a `dial` frame starts a {@link CallSession} and everything after
   * that belongs to it. Binary frames are the microphone and nothing else — text frames
   * are control — which is the whole of the framing on this wire.
   */
  private registerControl(instance: FastifyInstance, poster: WebhookPoster): void {
    instance.get('/control', { websocket: true }, (socket: WebSocket) => {
      const { store, config, logger } = this.options;
      let session: CallSession | null = null;

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          session?.audio(data);
          return;
        }
        const frame = decodeControlFrame(data.toString());
        switch (frame.type) {
          case 'dial': {
            if (session !== null) {
              send(socket, 'already_dialling', 'this socket already has a call on it');
              return;
            }
            const started = new CallSession({
              store,
              poster,
              config,
              logger,
              client: socket,
              claims: this.claims,
              feed: this.feed,
              onClosed: (closed) => this.sessions.delete(closed),
            });
            session = started;
            this.sessions.add(started);
            // Not awaited: the socket has to stay readable while the call runs, because
            // the microphone and the keypad arrive on it throughout.
            void started.dial(frame).catch((error: unknown) => {
              logger.error({ err: error }, 'a call failed outside its own error handling');
              void started.end('internal error');
            });
            return;
          }
          case 'dtmf':
            session?.dtmf(frame.digit);
            return;
          case 'mark':
            session?.mark(frame.name);
            return;
          case 'hangup':
            session?.hangupFromPage();
            return;
          default:
            send(socket, 'bad_frame', frame.message);
        }
      });

      socket.on('close', () => {
        // The page going away ends the call, which is what a handset being put down is.
        void session?.end('the page closed its socket');
      });
    });
  }

  async listen(): Promise<void> {
    await this.app.listen({ host: this.options.config.host, port: this.options.config.port });
  }

  /** Every live call is ended before the socket closes, so each posts its status callback. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions].map((session) => session.end('the simulator is shutting down')));
    // **Before `app.close()`, not after.** An SSE response never ends on its own and
    // Fastify's close waits on open connections, so a page left with `/api/calls/stream`
    // open would hang the shutdown outright — no error, no log line, just a process that
    // does not exit on Ctrl-C.
    this.feed.close();
    await this.app.close();
  }
}

function send(socket: WebSocket, code: string, message: string): void {
  socket.send(encodeControlEvent({ type: 'error', code, message }));
}
