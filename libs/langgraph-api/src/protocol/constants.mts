/**
 * Internal config flag set on runs created through the protocol transport.
 *
 * When present, the streaming layer forwards native protocol `messages`
 * lifecycle events directly instead of reconstructing them from legacy
 * message tuple callbacks.
 */
export const PROTOCOL_MESSAGES_STREAM_CONFIG_KEY = "__protocol_messages_stream";
