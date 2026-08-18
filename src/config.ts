/**
 * Options for {@link auto_propagate}.
 *
 * Every field is optional and every default is "propagate everything, change
 * nothing else". The filters exist for callers who need to keep baggage off
 * third-party hosts.
 */
export interface PropagateOptions {
  /** When set, only these baggage keys leave the process. */
  allowKeys?: string[] | null;
  /** When set, only these hosts receive baggage. A leading `*.` is supported. */
  allowHosts?: string[] | null;
  /** Hosts that never receive baggage. Takes precedence over `allowHosts`. */
  denyHosts?: string[] | null;
  /** Instrument inbound `node:http` / `node:https` servers. Default true. */
  http?: boolean;
  /** Instrument outbound `node:http`, `node:https` and `fetch`. Default true. */
  httpClient?: boolean;
  /** Log what was instrumented and what was skipped. Default false. */
  debug?: boolean;
}

/** Fully resolved options, with every default applied. */
export interface Config {
  allowKeys: string[] | null;
  allowHosts: string[] | null;
  denyHosts: string[] | null;
  http: boolean;
  httpClient: boolean;
  debug: boolean;
}

function normalizeList(input: string[] | null | undefined): string[] | null {
  if (!input || input.length === 0) return null;
  const items = input
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item !== '');
  return items.length > 0 ? items : null;
}

export function resolveConfig(options: PropagateOptions = {}): Config {
  return {
    allowKeys: normalizeList(options.allowKeys),
    allowHosts: normalizeList(options.allowHosts),
    denyHosts: normalizeList(options.denyHosts),
    http: options.http !== false,
    httpClient: options.httpClient !== false,
    debug: options.debug === true,
  };
}

/** Matches a host against one pattern, supporting a single leading `*.` wildcard. */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern === host) return true;
  if (pattern.slice(0, 2) === '*.') {
    const suffix = pattern.slice(1); // ".example.com"
    return host.length > suffix.length && host.slice(-suffix.length) === suffix;
  }
  return false;
}

/** Whether baggage may be sent to `host`. An unknown host is allowed. */
export function hostAllowed(config: Config, host: string | undefined): boolean {
  if (!host) return true;
  const normalized = host.toLowerCase().replace(/:\d+$/, '');
  if (config.denyHosts) {
    for (const pattern of config.denyHosts) if (hostMatches(normalized, pattern)) return false;
  }
  if (config.allowHosts) {
    for (const pattern of config.allowHosts) if (hostMatches(normalized, pattern)) return true;
    return false;
  }
  return true;
}

export function log(config: Config, message: string): void {
  if (config.debug) {
    // eslint-disable-next-line no-console
    console.log('[mirrord-sdk] ' + message);
  }
}
