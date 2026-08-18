import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

import type { Baggage } from '../baggage.js';
import { parse } from '../baggage.js';
import { state } from '../context.js';
import { HEADER } from '../outbound.js';

const PATCHED = Symbol.for('mirrord-sdk.server.v1');

type Emitter = { emit(event: string, ...args: unknown[]): boolean };
type PatchableProto = Emitter & { [PATCHED]?: true };

/**
 * Wraps the `request` event so every handler downstream of it — Express,
 * NestJS, Fastify, a bare listener — runs inside an async context seeded from
 * the inbound `baggage` header.
 *
 * `https.Server` does not inherit from `http.Server`, so both prototypes are
 * patched. A context is established even when the header is absent, so that
 * application code can call `set()` and have it propagate.
 */
function patchServerProto(proto: PatchableProto): (() => void) | null {
  if (proto[PATCHED]) return null;

  // Deliberately captured unbound: the replacement re-applies it with the
  // server instance as `this`, which is what keeps the patch transparent.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = proto.emit;

  proto.emit = function patchedEmit(this: Emitter, event: string, ...args: unknown[]): boolean {
    if (event !== 'request') return original.apply(this, [event, ...args]);
    let inbound: Baggage;
    try {
      const req = args[0] as IncomingMessage | undefined;
      const raw = req && req.headers ? req.headers[HEADER] : undefined;
      inbound = parse(typeof raw === 'string' ? raw : '');
    } catch {
      // A context is still established, so handlers can set() and propagate.
      inbound = new Map();
    }
    return state.storage.run(inbound, () => original.apply(this, [event, ...args]));
  };
  proto[PATCHED] = true;

  return () => {
    proto.emit = original;
    delete proto[PATCHED];
  };
}

export function installHttpServer(): Array<() => void> {
  const undo: Array<() => void> = [];
  for (const server of [http.Server, https.Server]) {
    const stop = patchServerProto(server.prototype);
    if (stop) undo.push(stop);
  }
  return undo;
}
