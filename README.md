# mirrord-sdk

Automatic [W3C Baggage](https://www.w3.org/TR/baggage/) propagation for Node, Bun and Deno.

An inbound request's `baggage` header becomes an ambient async context, and every outbound HTTP
call, `fetch`, axios request and SQS message made while handling that request carries it onward.

Work in progress — see the open pull requests.

## License

MIT
