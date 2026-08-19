/**
 * Options for {@link auto_propagate}.
 *
 * Deliberately empty. Propagation has no knobs: an inbound `baggage` header is
 * carried onto every outbound call, and that is the whole behaviour. The
 * parameter exists so a future option can be added without changing the
 * signature callers have already written.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PropagateOptions {}
