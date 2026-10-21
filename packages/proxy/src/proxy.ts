import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Capture, MAX_BODY_PARSE_BYTES, MAX_RESPONSE_PARSE_BYTES } from "./capture.js";
import type { BodyRetention, UsageRequest } from "@irori/core";

/**
 * Capture proxy (M8, ADR-0008): a raw byte pipe in front of a loopback
 * engine with a passive, capped tee. The forwarding path never inspects or
 * reinterprets the exchange — capture failures degrade to pass-through.
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** First N error-body bytes kept to lift `error.message`. */
const ERROR_BODY_KEEP = 16_384;

export interface CaptureProxyOptions {
  /** Client-facing port (the setup's declared port). */
  listenPort: number;
  /** Forwarding target — loopback engine per ADR-0008. */
  targetHost: string;
  targetPort: number;
  setupId: string | null;
  onEvent: (request: UsageRequest) => void;
  maxBodyBytes?: number;
  maxParseBytes?: number;
  /** IR-52 body retention caps; null/absent = retention off (v1 behavior). */
  retention?: BodyRetention | null;
  log?: (message: string) => void;
}

export class CaptureProxy {
  private readonly opts: {
    listenPort: number;
    targetHost: string;
    targetPort: number;
    setupId: string | null;
    onEvent: (request: UsageRequest) => void;
    maxBodyBytes: number;
    maxParseBytes: number;
    retention: BodyRetention | null;
    log: (message: string) => void;
  };
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(options: CaptureProxyOptions) {
    this.opts = {
      listenPort: options.listenPort,
      targetHost: options.targetHost,
      targetPort: options.targetPort,
      setupId: options.setupId,
      onEvent: options.onEvent,
      maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_PARSE_BYTES,
      maxParseBytes: options.maxParseBytes ?? MAX_RESPONSE_PARSE_BYTES,
      retention: options.retention ?? null,
      log: options.log ?? (() => {}),
    };
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Bound address once listening; null otherwise. */
  get address(): { port: number } | null {
    const addr = this.server?.address();
    return addr !== null && addr !== undefined && typeof addr === "object" ? { port: addr.port } : null;
  }

  get listenPort(): number {
    return this.opts.listenPort;
  }

  /** Binds synchronously once the promise resolves; throws on EADDRINUSE. */
  start(): Promise<void> {
    const server = createServer((req, res) => {
      try {
        void this.forward(req, res);
      } catch (err) {
        // Forwarding itself failed to start — mirror a refused engine.
        this.opts.log(`forward error: ${msg(err)}`);
        if (!res.headersSent) res.statusCode = 502;
        res.end();
      }
    });
    server.keepAliveTimeout = 5_000;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.server = server;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const onError = (err: Error): void => {
      server.close();
      this.server = null;
      reject(err);
    };
    server.once("error", onError);
    server.listen(this.opts.listenPort, "0.0.0.0", () => {
      server.off("error", onError);
      server.on("error", (err: Error) => this.opts.log(`listener error: ${err.message}`));
      const bound = this.address?.port ?? this.opts.listenPort;
      this.opts.log(`capture proxy listening on :${bound} → ${this.opts.targetHost}:${this.opts.targetPort}`);
      resolve();
    });
    return promise;
  }

  /** Closes the listener and drops remaining sockets (engine is going away). */
  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    server.close(() => resolve());
    this.opts.log(`capture proxy closed (:${this.opts.listenPort})`);
    return promise;
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    // The capture records the client-facing port actually bound (never the
    // ephemeral 0 a test/proxy may have requested).
    const boundPort = this.address?.port ?? this.opts.listenPort;
    const capture = Capture.wanted(req.method ?? "", req.url)
      ? new Capture({
          setupId: this.opts.setupId,
          port: boundPort,
          endpoint: (req.url ?? "").split("?")[0] ?? "/",
          sourceAddr: req.socket.remoteAddress ?? null,
          retention: this.opts.retention,
        })
      : null;

    const headers: Record<string, string | string[] | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = `${this.opts.targetHost}:${this.opts.targetPort}`;

    const upstream = httpRequest({
      host: this.opts.targetHost,
      port: this.opts.targetPort,
      method: req.method,
      path: req.url,
      headers,
    });
    upstream.setTimeout(0);

    let clientGone = false;
    const abortUpstream = (): void => {
      upstream.destroy();
    };
    req.on("aborted", () => {
      clientGone = true;
      capture?.observeError("client aborted before the response completed");
      abortUpstream();
    });
    res.on("close", () => {
      clientGone = true;
      abortUpstream();
    });

    req.on("data", (chunk: Buffer) => capture?.observeRequestBody(chunk));
    req.on("end", () => capture?.observeRequestEnd());
    req.pipe(upstream);

    upstream.on("error", (err: Error) => {
      capture?.observeError(`upstream unreachable: ${err.message}`);
      if (!res.headersSent) res.statusCode = 502;
      res.end();
      this.emit(capture);
    });
    upstream.on("response", (upstreamRes) => {
      capture?.observeResponseStart(upstreamRes.statusCode ?? 0);
      const outHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
        outHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);

      let errorBody: Buffer | null = (upstreamRes.statusCode ?? 0) >= 400 ? Buffer.alloc(0) : null;
      // Backpressure: when the client stops draining, pause the upstream so
      // engine bytes don't buffer unbounded in memory; resume on drain.
      let paused = false;
      const pumpDrain = (): void => {
        if (paused && res.writableNeedDrain === false) {
          paused = false;
          upstreamRes.resume();
        }
      };
      res.on("drain", pumpDrain);
      upstreamRes.on("data", (chunk: Buffer) => {
        try {
          capture?.observeResponseChunk(chunk, Date.now());
          if (errorBody !== null && errorBody.length < ERROR_BODY_KEEP) {
            errorBody = Buffer.concat([errorBody, chunk.subarray(0, ERROR_BODY_KEEP - errorBody.length)]);
          }
        } catch (err) {
          this.opts.log(`capture tee failed (ignored): ${msg(err)}`);
        }
        // Byte-identity: raw chunk out, in arrival order.
        if (!clientGone) {
          if (res.write(chunk) === false && !paused) {
            paused = true;
            upstreamRes.pause();
          }
        }
      });
      upstreamRes.on("end", () => {
        res.off("drain", pumpDrain);
        if (errorBody !== null && errorBody.length > 0) capture?.observeErrorBody(errorBody);
        res.end();
        this.emit(capture);
      });
      upstreamRes.on("error", (err: Error) => {
        capture?.observeError(`upstream stream failed: ${err.message}`);
        if (!clientGone) res.end();
        this.emit(capture);
      });
    });
  }

  /** Fail-open: a throwing sink or parser never affects traffic. */
  private emit(capture: Capture | null): void {
    if (capture === null) return;
    try {
      const event = capture.finish();
      if (event !== null) {
        try {
          this.opts.onEvent(event);
        } catch (err) {
          this.opts.log(`usage sink failed (ignored): ${msg(err)}`);
        }
      }
    } catch (err) {
      this.opts.log(`capture finish failed (ignored): ${msg(err)}`);
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
