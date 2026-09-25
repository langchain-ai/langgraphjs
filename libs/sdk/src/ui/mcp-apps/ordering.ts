/**
 * The SEP-1865 tool input ordering, as one pure function.
 *
 * Its own module, with no imports, because it is the only piece of this
 * package that is a rule rather than plumbing: zero or more partials, then
 * exactly one `tool-input`, then nothing, and none of it before the view has
 * said `initialized`. Everything around it is React and a postMessage bridge,
 * neither of which a test should have to stand up to check a rule.
 */

/** What to send the view next, given where the conversation stands. */
export function toolInputAction(state: {
  /** The view has sent `ui/notifications/initialized`. */
  ready: boolean;
  /** The one `tool-input` has already gone. */
  sentFinal: boolean;
  /** The model is still writing the arguments. */
  streaming: boolean;
}): "partial" | "final" | "none" {
  // A host MUST NOT send anything before the view is initialized. Sending
  // early is silent: the view simply never draws.
  if (!state.ready || state.sentFinal) return "none";
  return state.streaming ? "partial" : "final";
}
