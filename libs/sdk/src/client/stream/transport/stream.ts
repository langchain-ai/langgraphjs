/**
 * `ReadableStream` + `AsyncIterable` adapter used by the protocol
 * transport. The implementation is shared with the legacy stream paths
 * (see {@link ../../../utils/stream.js}) so the async-iteration and
 * reader lifecycle semantics only live in one place.
 */
export { IterableReadableStream } from "../../../utils/stream.js";
