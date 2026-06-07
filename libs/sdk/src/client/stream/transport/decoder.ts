/**
 * SSE byte/line decoding for the protocol transport.
 *
 * The actual decoder implementation is shared with the legacy stream
 * paths and lives in {@link ../../../utils/sse.js} so byte-level parsing
 * semantics (universal newlines, partial frames, comment/`retry`/`id`
 * handling) only need to be maintained in one place.
 */
export { BytesLineDecoder, SSEDecoder } from "../../../utils/sse.js";
export type { StreamPart } from "../../../utils/sse.js";
