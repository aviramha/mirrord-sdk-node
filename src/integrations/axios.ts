import type { Config } from '../config.js';
import { resolveConfig } from '../config.js';
import { HEADER, findHeader, outboundHeader } from '../outbound.js';

interface AxiosRequestConfigLike {
  url?: string;
  baseURL?: string;
  headers?: Record<string, unknown>;
}

interface AxiosLike {
  interceptors: {
    request: {
      use(onFulfilled: (config: AxiosRequestConfigLike) => AxiosRequestConfigLike): number;
      eject(id: number): void;
    };
  };
}

function hostOf(config: AxiosRequestConfigLike): string | undefined {
  try {
    const base = config.baseURL;
    const url = config.url || '';
    return new URL(url, base || 'http://localhost').hostname;
  } catch {
    return undefined;
  }
}

/**
 * Registers a request interceptor on an axios instance.
 *
 * In Node, axios goes through `node:http`, so the automatic hook already covers
 * it. Reach for this when axios is configured with the `fetch` or `xhr`
 * adapter, when running in a browser bundle, or when you want the header
 * visible to your own downstream interceptors.
 *
 * Returns the interceptor id so it can be ejected.
 */
export function instrumentAxios(instance: AxiosLike, config: Config = resolveConfig()): number {
  return instance.interceptors.request.use((requestConfig) => {
    try {
      return addHeader(requestConfig, config);
    } catch {
      // An interceptor that throws would reject the request outright.
      return requestConfig;
    }
  });
}

function addHeader(requestConfig: AxiosRequestConfigLike, config: Config): AxiosRequestConfigLike {
  {
    const header = outboundHeader(config, hostOf(requestConfig));
    if (header === null) return requestConfig;

    // Axios 1.x hands over an AxiosHeaders instance, which supports `set` and
    // behaves case-insensitively; a plain object is used before 1.x and in some
    // hand-built configs.
    const headers = requestConfig.headers;

    if (headers && typeof headers.set === 'function') {
      if (typeof headers.has === 'function' && headers.has(HEADER)) return requestConfig;
      headers.set(HEADER, header);
      return requestConfig;
    }

    const plain: Record<string, unknown> = { ...(headers || {}) };
    if (findHeader(plain, HEADER) !== undefined) return requestConfig;
    plain[HEADER] = header;
    requestConfig.headers = plain;
    return requestConfig;
  }
}

export default instrumentAxios;
