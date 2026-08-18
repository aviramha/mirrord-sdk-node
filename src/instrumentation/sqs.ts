import { createRequire } from 'node:module';

import { parse } from '../baggage.js';
import type { Baggage } from '../baggage.js';
import { state } from '../context.js';
import { HEADER, outboundHeader } from '../outbound.js';

/**
 * The message attribute name carrying baggage.
 *
 * SQS attribute names are case-sensitive and may not start with `AWS.` or
 * `Amazon.`, so the header name is reused verbatim.
 */
export const SQS_ATTRIBUTE = HEADER;

const SEND_COMMANDS = ['SendMessageCommand', 'SendMessageBatchCommand'];

interface StringMessageAttribute {
  DataType: string;
  StringValue?: string;
}

interface SendMessageInput {
  MessageAttributes?: Record<string, StringMessageAttribute>;
}

interface SendMessageBatchInput {
  Entries?: SendMessageInput[];
}

interface ReceiveMessageInput {
  MessageAttributeNames?: string[];
}

/** The shape of an SQS message, narrowed to what propagation needs. */
export interface SqsMessageLike {
  MessageAttributes?: Record<string, { StringValue?: string } | undefined>;
  messageAttributes?: Record<string, { stringValue?: string; StringValue?: string } | undefined>;
}

/**
 * Reads baggage off a received SQS message.
 *
 * Handles both the SDK's `MessageAttributes` casing and the Lambda event
 * source mapping's `messageAttributes` / `stringValue` casing, because a queue
 * is frequently produced by one and consumed by the other.
 */
export function extractFromMessage(input: unknown): Baggage {
  if (!input || typeof input !== 'object') return new Map();
  const message = input as SqsMessageLike;
  const sdk = message.MessageAttributes && message.MessageAttributes[SQS_ATTRIBUTE];
  if (sdk && typeof sdk.StringValue === 'string') return parse(sdk.StringValue);
  const lambda = message.messageAttributes && message.messageAttributes[SQS_ATTRIBUTE];
  if (lambda) {
    const value = lambda.stringValue ?? lambda.StringValue;
    if (typeof value === 'string') return parse(value);
  }
  return new Map();
}

/**
 * Runs a message handler inside the async context carried by the message.
 *
 * This is the consumer half of SQS propagation. It has to be explicit: worker
 * libraries dispatch messages through their own abstractions, so there is no
 * single call site to patch the way there is for an HTTP server.
 */
export function runWithMessage<T>(message: unknown, fn: () => T): T {
  return state.storage.run(extractFromMessage(message), fn);
}

/** A per-message handler, however many extra arguments the worker library passes. */
export type MessageHandler<M, A extends unknown[], R> = (message: M, ...rest: A) => R;

/**
 * Wraps a handler so every invocation adopts its message's baggage.
 *
 * The message type is left open rather than constrained to {@link SqsMessageLike}:
 * worker libraries hand over their own message shapes, and the attributes are
 * read defensively anyway.
 */
export function wrapMessageHandler<M, A extends unknown[], R>(
  handler: MessageHandler<M, A, R>,
): MessageHandler<M, A, R> {
  return function wrapped(this: unknown, message: M, ...rest: A): R {
    return runWithMessage(message, () => handler.call(this, message, ...rest));
  };
}

function injectIntoInput(input: SendMessageInput, header: string): void {
  const attributes = input.MessageAttributes || (input.MessageAttributes = {});
  // An explicitly set attribute wins, matching the HTTP header behaviour.
  if (attributes[SQS_ATTRIBUTE]) return;
  attributes[SQS_ATTRIBUTE] = { DataType: 'String', StringValue: header };
}

/**
 * The AWS SDK v3 middleware that carries baggage across a queue.
 *
 * It sits in the `initialize` step, which runs before serialization and before
 * SigV4 signing — mutating the request body any later would invalidate the
 * signature.
 */
function createSqsMiddleware() {
  return function baggageMiddleware(
    next: (args: unknown) => unknown,
    context: { commandName?: string },
  ) {
    return function handle(args: { input?: unknown }) {
      const commandName = context && context.commandName;
      try {
        if (commandName && SEND_COMMANDS.indexOf(commandName) !== -1) {
          const header = outboundHeader();
          if (header !== null && args.input) {
            if (commandName === 'SendMessageCommand') {
              injectIntoInput(args.input, header);
            } else {
              const entries = (args.input as SendMessageBatchInput).Entries;
              if (Array.isArray(entries))
                for (const entry of entries) injectIntoInput(entry, header);
            }
          }
        } else if (commandName === 'ReceiveMessageCommand' && args.input) {
          // ReceiveMessage returns no message attributes unless they are asked
          // for by name, so a consumer that never requested any would silently
          // see an empty context.
          const input = args.input as ReceiveMessageInput;
          const names = input.MessageAttributeNames;
          if (!Array.isArray(names)) {
            input.MessageAttributeNames = [SQS_ATTRIBUTE];
          } else if (
            names.indexOf('All') === -1 &&
            names.indexOf('.*') === -1 &&
            names.indexOf(SQS_ATTRIBUTE) === -1
          ) {
            names.push(SQS_ATTRIBUTE);
          }
        }
      } catch {
        // Never let instrumentation break the command it is decorating.
      }
      return next(args);
    };
  };
}

const MIDDLEWARE_NAME = 'mirrordBaggageMiddleware';

interface MiddlewareStackClient {
  middlewareStack?: {
    add(middleware: unknown, options: Record<string, unknown>): void;
    remove(nameOrId: string): boolean;
  };
}

/**
 * Adds baggage propagation to one SQS client.
 *
 * Use this when the automatic hook cannot reach the SDK — a pure-ESM app, a
 * bundled Lambda, or a vendored copy of `@aws-sdk/client-sqs`.
 */
export function instrumentSQSClient(client: MiddlewareStackClient): boolean {
  const stack = client && client.middlewareStack;
  if (!stack || typeof stack.add !== 'function') return false;
  // `add` with the same name twice throws in the SDK; removing first makes the
  // call idempotent.
  try {
    stack.remove(MIDDLEWARE_NAME);
  } catch {
    // Not present yet.
  }
  stack.add(createSqsMiddleware(), {
    step: 'initialize',
    name: MIDDLEWARE_NAME,
    tags: ['BAGGAGE', 'CONTEXT_PROPAGATION'],
    override: true,
  });
  return true;
}

/** Resolves a module from the application's dependency tree, not this package's. */
function resolveFromApp(id: string): unknown {
  const candidates: Array<() => unknown> = [
    () => createRequire(process.cwd() + '/package.json')(id),
    () => createRequire(__filename)(id),
  ];
  for (const attempt of candidates) {
    try {
      return attempt();
    } catch {
      // Try the next resolution base.
    }
  }
  return null;
}

/**
 * Hooks `SQSClient.prototype.send` so clients constructed anywhere in the app —
 * before or after install — pick up the middleware on first use.
 */
export function installSqs(): Array<() => void> {
  const mod = resolveFromApp('@aws-sdk/client-sqs') as {
    SQSClient?: { prototype: Record<string, unknown> };
  } | null;
  const proto = mod && mod.SQSClient && mod.SQSClient.prototype;
  // Absent from the application's dependencies: nothing to instrument.
  if (!proto || typeof proto.send !== 'function') return [];

  const original = proto.send as (...args: unknown[]) => unknown;
  const seen = new WeakSet<object>();

  proto.send = function patchedSend(this: MiddlewareStackClient, ...args: unknown[]) {
    try {
      if (!seen.has(this)) {
        seen.add(this);
        instrumentSQSClient(this);
      }
    } catch {
      // An SDK version whose middleware stack differs must not break send().
    }
    return original.apply(this, args);
  };
  return [
    () => {
      proto.send = original;
    },
  ];
}
