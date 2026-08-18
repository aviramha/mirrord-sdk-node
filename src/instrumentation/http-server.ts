import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

import type { Baggage } from '../baggage.js';
import { parse } from '../baggage.js';
import type { Config } from '../config.js';
import { log } from '../config.js';
import { state } from '../context.js';
import { HEADER } from '../outbound.js';

const PATCHED = Symbol.for('metalbear.mirrord-baggage.server.v1');

type Emitter = { emit(event: string, ...args: unknown[]): boolean };
type PatchableProto = Emitter & { [PATCHED]?: true };

/**
 * Wraps the `request` event so every handler downstream of it — Express,
 * NestJS, Fastify, a bare listener — runs inside an async context seeded from
 * the inbound `baggage` header.
 *
 * `https.Server` does not inherit from `http.Server`, so both prototypes are
 * patched. A context is established even when the header is absent, so that
 * application code can call `set()` and have it propagate onward.
 */
function patchServerProto(
  proto: PatchableProto,
  label: string,
  config: Config,
): (() => void) | null {
  if (proto[PATCHED]) {
    log(config, label + ' server already instrumented');
    return null;
  }
  // Deliberately captured unbound: the replacement re-applies it with the
  // server instance as `this`, which is what keeps the patch transparent.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = proto.emit;

  proto.emit = function patchedEmit(this: Emitter, event: string, ...args: unknown[]): boolean {
    if (event !== 'request') return original.apply(this, [event, ...args]);
    let inbound: Baggage;
    try {
      const req = args[0] as IncomingMessage | undefined;
      inbound = parse(req && req.headers ? req.headers[HEADER] : undefined);
    } catch {
      // A context is still established, so handlers can set() and propagate.
      inbound = new Map();
    }
    return state.storage.run(inbound, () => original.apply(this, [event, ...args]));
  };
  proto[PATCHED] = true;
  log(config, 'instrumented inbound ' + label + ' server');

  return () => {
    proto.emit = original;
    delete proto[PATCHED];
  };
}

export function installHttpServer(config: Config): Array<() => void> {
  const undo: Array<() => void> = [];
  const httpUndo = patchServerProto(http.Server.prototype, 'http', config);
  if (httpUndo) undo.push(httpUndo);

  // Guard: on runtimes where `https.Server` is an alias of `http.Server`, the
  // symbol check inside patchServerProto already short-circuits.
  const httpsUndo = patchServerProto(https.Server.prototype, 'https', config);
  if (httpsUndo) undo.push(httpsUndo);

  return undo;
}
