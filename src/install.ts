import type { Config, PropagateOptions } from './config.js';
import { log, resolveConfig } from './config.js';
import { state } from './context.js';
import { installFetch } from './instrumentation/fetch.js';
import { installHttpClient } from './instrumentation/http-client.js';
import { installHttpServer } from './instrumentation/http-server.js';

export interface PropagateHandle {
  /** True once instrumentation is in place. */
  active: boolean;
  /** Which surfaces were instrumented. */
  instrumented: string[];
  /** Removes every hook this call installed. */
  stop(): void;
}

function makeHandle(): PropagateHandle {
  return {
    active: state.installed,
    instrumented: state.instrumented.slice(),
    stop: stop_propagate,
  };
}

/**
 * Starts automatic W3C Baggage propagation.
 *
 * Call it once, as early as possible in your entry point:
 *
 *     import mirrord from 'mirrord-sdk';
 *     mirrord.auto_propagate();
 *
 * From then on, an inbound `baggage` header becomes an ambient async context,
 * and every outbound HTTP call, `fetch`, and SQS message sent while handling
 * that request carries it onward.
 *
 * Calling it more than once is a no-op rather than a second layer of hooks.
 * Every hook is wrapped so that a failure inside instrumentation can never
 * break the call it is decorating.
 */
export function auto_propagate(options: PropagateOptions = {}): PropagateHandle {
  if (state.installed) return makeHandle();

  const config: Config = resolveConfig(options);
  const undo: Array<() => void> = [];
  const instrumented: string[] = [];

  const step = (name: string, fn: () => Array<() => void>): void => {
    try {
      const hooks = fn();
      if (hooks.length > 0) {
        undo.push(...hooks);
        instrumented.push(name);
      }
    } catch (error) {
      // One unavailable surface must never stop the others from installing.
      log(config, 'skipped ' + name + ': ' + String(error));
    }
  };

  if (config.http) step('http-server', () => installHttpServer(config));
  if (config.httpClient) {
    step('http-client', () => installHttpClient(config));
    step('fetch', () => installFetch(config));
  }
  state.installed = true;
  state.instrumented = instrumented;
  state.uninstall = undo;
  log(config, 'propagating via ' + (instrumented.join(', ') || 'nothing'));
  return makeHandle();
}

/** Removes every hook installed by {@link auto_propagate}. */
export function stop_propagate(): void {
  for (let i = state.uninstall.length - 1; i >= 0; i--) {
    try {
      state.uninstall[i]();
    } catch {
      // Best effort: keep unwinding the rest.
    }
  }
  state.uninstall = [];
  state.instrumented = [];
  state.installed = false;
}

/** Whether propagation is currently active. */
export function is_propagating(): boolean {
  return state.installed;
}
