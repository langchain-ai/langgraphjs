/**
 * Internal kwargs flag set on runs created through the protocol transport.
 *
 * When present, the streaming layer uses `streamStateV2` and forwards native
 * protocol events to the v2 protocol session.
 */
export const PROTOCOL_STREAM_RUN_KEY = "__protocol_stream_run";
