/**
 * Replies and ids shared between the streaming graph fixtures and the
 * browser tests. Kept dependency-free so the browser bundle can import it,
 * unlike the graph fixtures themselves.
 */

/** Marker that makes `streaming_text_graph` stream its reply slowly. */
export const SLOW_MARKER = "[slow]";

/** `streaming_text_graph` reply to a message containing {@link SLOW_MARKER}. */
export const SLOW_REPLY =
  "This reply streams slowly so the test can act while it is in flight.";

/** `streaming_text_graph` reply to any other message. */
export const QUICK_REPLY = "Quick reply.";

/** `reply_then_interrupt_graph` reply, streamed before the run pauses. */
export const DRAFT_REPLY = "Draft reply ready for review.";

