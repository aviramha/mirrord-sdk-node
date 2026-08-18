import { parse } from '../baggage.js';
import { state } from '../context.js';
import { HEADER } from '../outbound.js';

interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

type NextFn = (error?: unknown) => void;

/**
 * Connect/Express middleware that seeds the async context from the inbound
 * `baggage` header.
 *
 * The automatic `node:http` server hook already covers Express and NestJS, so
 * this is only needed when running with `MIRRORD_BAGGAGE_HTTP=false`, behind a
 * server this package does not patch, or when you want the context to start at
 * a specific point in the middleware chain.
 */
export function baggageMiddleware(req: RequestLike, _res: unknown, next: NextFn): void {
  const header = req && req.headers ? req.headers[HEADER] : undefined;
  state.storage.run(parse(header), () => next());
}

export default baggageMiddleware;
