/**
 * Carriage return byte used while scanning raw SSE payloads.
 */
export const CR = "\r".charCodeAt(0);

/**
 * Line feed byte used while scanning raw SSE payloads.
 */
export const LF = "\n".charCodeAt(0);

/**
 * Null byte used when validating SSE event ids.
 */
export const NULL = "\0".charCodeAt(0);

/**
 * Colon byte used to split SSE field names from values.
 */
export const COLON = ":".charCodeAt(0);

/**
 * Space byte used to trim optional leading whitespace in SSE field values.
 */
export const SPACE = " ".charCodeAt(0);

/**
 * Newline byte values that terminate a line while decoding SSE payloads.
 */
export const TRAILING_NEWLINE = [CR, LF];
