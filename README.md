# mirrord-sdk

Automatic [W3C Baggage](https://www.w3.org/TR/baggage/) propagation for Node, Bun and Deno.

An inbound request's `baggage` header becomes an ambient async context, and every outbound HTTP
call, `fetch`, axios request and SQS message made while handling that request carries it onward. No
context object threaded through your call signatures.

## Why this exists

[mirrord](https://mirrord.dev) lets a developer, a CI preview environment or an AI agent run one
service locally against a shared cluster, and routes only _their_ requests to it. Which requests
those are is decided by a filter — commonly on the
[`baggage` header](https://mirrord.dev/docs/using-mirrord/incoming-traffic/filter-incoming-traffic/)
for HTTP, and on a message attribute for
[SQS queue splitting](https://mirrord.dev/docs/sharing-the-cluster/queue-splitting/sqs/).

The catch is that a filter only matches where the request arrives. If the first service does not
forward the value when it calls the next one, the second service never matches, the request falls
back to the cluster's copy, and everything past the first hop is someone else's code. The value has
to travel the whole chain — through every HTTP call and every queue.

mirrord's docs describe doing that by hand: read the header, stash it in request context, add it to
every outgoing request and every SQS message attribute, in every service. This package does it for
you in Node, without touching your handlers.

Nothing here is mirrord-specific. It is plain W3C Baggage, so it works for whatever else you want
to carry across a request chain.

```bash
npm install mirrord-sdk
```

## Use

One call, as early as possible in your entry point:

```ts
// main.ts / index.js
import mirrord from 'mirrord-sdk';

mirrord.auto_propagate();
```

That is the whole setup.

## What it hooks

| Surface          | Covers                                                               |
| ---------------- | -------------------------------------------------------------------- |
| Inbound HTTP     | NestJS, Express, Fastify, bare `node:http`                           |
| Outbound HTTP    | axios, got, `node-fetch`, AWS SDK, anything on `node:http`/`https`   |
| Outbound `fetch` | Node 18+, Bun, Deno                                                  |
| SQS              | `SendMessage`, `SendMessageBatch` — as a `baggage` message attribute |

An outbound call that already sets a `baggage` header is never overwritten.

## SQS consumers

Sending is automatic. **Receiving is not — the consumer has to change, or the chain stops at the
queue.** The SDK hands back an array of messages and never sees the code that processes them, so
only you can say where one message begins.

Wrap your handler:

```ts
import { get, wrapMessageHandler } from 'mirrord-sdk';

const handler = wrapMessageHandler(async (message) => {
  get('user'); // whatever the producer sent
  await downstream(); // carries it onward, over HTTP or to the next queue
});
```

Or start the context inline, if the handler is not yours to wrap:

```ts
import { runWithMessage } from 'mirrord-sdk';

await runWithMessage(message, async () => {
  await downstream();
});
```

Both accept the SDK's `MessageAttributes` shape and the Lambda event source mapping's
`messageAttributes` / `stringValue` casing. `ReceiveMessage` already asks SQS for the `baggage`
attribute, which it otherwise would not return.

## Reading and extending the context

Rarely needed — forwarding what arrived is the common case — but the context is readable and
writable anywhere downstream of an inbound request:

```ts
import { get, getAll, set } from 'mirrord-sdk';

get('user'); // 'alice@metalbear.com' — from the inbound header
set('tenant', 'acme'); // rides along on every outbound call from here on
getAll(); // { user: 'alice@metalbear.com', tenant: 'acme' }
```

## Options

There are none. `auto_propagate()` takes an options object so one can be added later without
changing the call you already wrote, but nothing reads it today: an inbound `baggage` header is
carried onto every outbound call, and that is the whole behaviour.

`auto_propagate()` returns a handle. `handle.instrumented` lists what was hooked, `handle.stop()`
removes every hook. Calling it twice is a no-op, not a second layer.

Baggage that arrived from a caller you do not control is forwarded to every outbound host,
including third-party APIs. If that is not what you want, do not put anything sensitive in baggage.

## API

```ts
auto_propagate() → handle    stop_propagate()    is_propagating()
get(key)   getAll()   set(key, value)   remove(key)   currentHeader()
runWith(baggage, fn)   runWithAdded({...}, fn)   bind(fn)
parse(header) → Baggage              serialize(baggage) → string
wrapMessageHandler(fn)   runWithMessage(message, fn)   extractFromMessage(message)

instrumentSQSClient(client)   // only for an SQS client the automatic hook misses
```

One entry point, no subpaths.

## Compatibility

Node 14.18+, Bun, Deno. CJS and ESM builds ship side by side and share one context. Zero runtime
dependencies.

`@aws-sdk/client-sqs` is an optional peer: it is never installed for you, and if it is absent the
SQS hook simply installs nothing. The `>=3.0.0` range is the whole of AWS SDK v3 and has been
checked against it — 3.0.0 through current, spanning the switch from the query protocol to AWS
JSON. Only the Smithy middleware stack and `commandName` are used, both of which have been stable
across v3.

AWS SDK **v2** (the `aws-sdk` package) is a different package with a different middleware model and
is not supported. SQS calls made through it carry no baggage; HTTP propagation is unaffected.

## Development

```bash
npm install
npm test                 # build, unit, e2e, cross-runtime smoke
npm run lint
npm run format
npm run verify:package   # pack and install into throwaway consumers
```

## License

MIT
