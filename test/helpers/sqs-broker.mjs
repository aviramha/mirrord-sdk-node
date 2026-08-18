/**
 * A local SQS broker that speaks the wire protocol.
 *
 * It plugs in as the SDK's `requestHandler`, so a `SendMessageCommand` travels
 * the full client path — middleware stack, serializer, signer — and what the
 * broker sees is the actual JSON body that would have gone to AWS. Messages are
 * then handed back in the shape `ReceiveMessage` returns.
 *
 * Delivery is pumped explicitly by `drain()` from the test's top level rather
 * than fired from inside the sender's callback. That matters: a consumer
 * invoked inside the producer's async context would inherit its baggage through
 * AsyncLocalStorage and the test would pass without anything having crossed the
 * queue. Draining from outside proves the context was carried by the message.
 */
import { Readable } from 'node:stream';

const OPERATION = /^AmazonSQS\.(\w+)$/;

export function createBroker() {
  const queues = new Map();
  let counter = 0;

  const queue = (url) => {
    if (!queues.has(url)) queues.set(url, { pending: [], consumer: null });
    return queues.get(url);
  };

  const enqueue = (url, { MessageBody, MessageAttributes }) => {
    const message = {
      MessageId: `m-${++counter}`,
      ReceiptHandle: `r-${counter}`,
      Body: MessageBody,
      MessageAttributes: MessageAttributes || {},
    };
    queue(url).pending.push(message);
    return message;
  };

  function handleOperation(operation, input) {
    switch (operation) {
      case 'SendMessage': {
        const message = enqueue(input.QueueUrl, input);
        return { MessageId: message.MessageId, MD5OfMessageBody: 'stub' };
      }
      case 'SendMessageBatch': {
        const successful = (input.Entries || []).map((entry) => ({
          Id: entry.Id,
          MessageId: enqueue(input.QueueUrl, entry).MessageId,
          MD5OfMessageBody: 'stub',
        }));
        return { Successful: successful, Failed: [] };
      }
      case 'ReceiveMessage': {
        const q = queue(input.QueueUrl);
        const taken = q.pending.splice(0, input.MaxNumberOfMessages || 10);
        return taken.length > 0 ? { Messages: taken } : {};
      }
      case 'DeleteMessage':
        return {};
      default:
        throw new Error(`unsupported SQS operation: ${operation}`);
    }
  }

  return {
    /** Pass as `requestHandler` when constructing an SQSClient. */
    requestHandler: {
      handle: async (request) => {
        const target = request.headers['x-amz-target'] || request.headers['X-Amz-Target'] || '';
        const match = OPERATION.exec(target);
        if (!match) throw new Error(`no SQS operation in target: ${target}`);
        const body =
          typeof request.body === 'string'
            ? request.body
            : Buffer.from(request.body).toString('utf8');
        const output = handleOperation(match[1], JSON.parse(body));
        return {
          response: {
            statusCode: 200,
            reason: 'OK',
            headers: { 'content-type': 'application/x-amz-json-1.0' },
            body: Readable.from([Buffer.from(JSON.stringify(output))]),
          },
        };
      },
    },

    /** Registers the handler invoked for each message on a queue. */
    subscribe(url, handler) {
      queue(url).consumer = handler;
    },

    /** Publishes directly, as a producer outside this process would. */
    publish(url, body, baggageHeader) {
      enqueue(url, {
        MessageBody: body,
        MessageAttributes: baggageHeader
          ? { baggage: { DataType: 'String', StringValue: baggageHeader } }
          : undefined,
      });
    },

    /**
     * Runs every pending message through its consumer, repeating until the
     * queues are empty so a chain of workers runs to completion.
     */
    async drain(maxRounds = 20) {
      for (let round = 0; round < maxRounds; round++) {
        const batch = [];
        for (const [url, q] of queues) {
          if (!q.consumer) continue;
          while (q.pending.length > 0) batch.push([q.consumer, q.pending.shift(), url]);
        }
        if (batch.length === 0) return;
        for (const [consumer, message] of batch) await consumer(message);
      }
      throw new Error('drain did not settle — a consumer is producing in a loop');
    },

    /** Messages left on a queue that has no consumer, i.e. the end of a chain. */
    sink(url) {
      return queue(url).pending;
    },
  };
}

/** Reads the baggage header off a message the broker delivered. */
export function baggageOf(message) {
  return message?.MessageAttributes?.baggage?.StringValue ?? null;
}
