/**
 * Separator used to create stable string keys from namespace tuples.
 * The null character cannot collide with protocol namespace segments,
 * which are printable identifiers.
 */
export const NAMESPACE_SEPARATOR = "\u0000";

/**
 * Default state / values key that holds the message array for stream
 * controllers and UI bindings.
 */
export const DEFAULT_MESSAGES_KEY = "messages";

/**
 * A create request answers once its run exists, normally well within this.
 * Past it, a request kept open after a stop closes, and a run it still
 * creates keeps going.
 */
export const STOP_RUN_ID_WAIT_MS = 5_000;
