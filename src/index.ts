import {
  active,
  bind,
  currentHeader,
  get,
  getAll,
  remove,
  runWith,
  runWithAdded,
  set,
} from './context.js';
import { auto_propagate, is_propagating, stop_propagate } from './install.js';
import { extractFromMessage, runWithMessage, wrapMessageHandler } from './instrumentation/sqs.js';

export { MAX_MEMBERS, MAX_MEMBER_BYTES, MAX_TOTAL_BYTES, parse, serialize } from './baggage.js';
export type { Baggage, BaggageEntry } from './baggage.js';

export type { PropagateOptions } from './config.js';

export {
  active,
  bind,
  currentHeader,
  get,
  getAll,
  remove,
  runWith,
  runWithAdded,
  set,
} from './context.js';
export type { BaggageInput } from './context.js';

export { HEADER } from './outbound.js';

export { auto_propagate, is_propagating, stop_propagate } from './install.js';
export type { PropagateHandle } from './install.js';

export {
  SQS_ATTRIBUTE,
  createSqsMiddleware,
  extractFromMessage,
  instrumentSQSClient,
  runWithMessage,
  wrapMessageHandler,
} from './instrumentation/sqs.js';
export type { MessageHandler, SqsMessageLike } from './instrumentation/sqs.js';

export { instrumentAxios } from './integrations/axios.js';
export { baggageMiddleware } from './integrations/express.js';

/**
 * camelCase alias for {@link auto_propagate}, for codebases that would rather
 * not have a snake_case call in the middle of an entry point.
 */
export const autoPropagate = auto_propagate;

/** Default export, so `import mirrord from 'mirrord-sdk'` reads naturally. */
const mirrord = {
  auto_propagate,
  autoPropagate,
  stop_propagate,
  is_propagating,
  get,
  getAll,
  set,
  remove,
  active,
  currentHeader,
  runWith,
  runWithAdded,
  bind,
  extractFromMessage,
  runWithMessage,
  wrapMessageHandler,
};

export default mirrord;
