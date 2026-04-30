/**
 * Internal config flag set on runs created through the protocol transport.
 *
 * When present, the streaming layer uses `streamStateV2` and forwards native
 * protocol events to the v2 protocol session.
 */
export const PROTOCOL_MESSAGES_STREAM_CONFIG_KEY = "__protocol_messages_stream";
