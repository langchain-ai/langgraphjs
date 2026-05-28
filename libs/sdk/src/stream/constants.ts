/**
 * Separator used to create stable string keys from namespace tuples.
 * The null character cannot collide with protocol namespace segments,
 * which are printable identifiers.
 */
export const NAMESPACE_SEPARATOR = "\u0000";
