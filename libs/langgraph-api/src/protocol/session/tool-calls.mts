import { isRecord } from "./internal-types.mjs";

/**
 * Extracts the stable identity fields for a tuple tool call.
 *
 * @param value - Serialized tool call payload.
 * @returns The resolved identifier and function name, when present.
 */
export const getTupleToolCallIdentity = (value: Record<string, unknown>) => {
  const nestedFunction = isRecord(value.function) ? value.function : undefined;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name:
      typeof value.name === "string"
        ? value.name
        : typeof nestedFunction?.name === "string"
          ? nestedFunction.name
          : undefined,
  };
};

/**
 * Extracts the raw argument payload for a tuple tool call.
 *
 * @param value - Serialized tool call payload.
 * @returns The raw arguments field, if present.
 */
export const getTupleToolCallArgs = (value: Record<string, unknown>) => {
  if ("args" in value) return value.args;

  const nestedFunction = isRecord(value.function) ? value.function : undefined;
  return nestedFunction?.arguments;
};

/**
 * Parses the final argument payload for a completed tool call.
 *
 * @param value - Raw tool call arguments.
 * @returns The parsed arguments plus a validity flag.
 */
export const normalizeFinalToolCallArgs = (value: unknown) => {
  if (isRecord(value)) {
    return { valid: true, args: value as unknown };
  }

  if (typeof value === "string") {
    if (value.length === 0) {
      return { valid: true, args: {} };
    }

    try {
      return {
        valid: true,
        args: JSON.parse(value) as unknown,
      };
    } catch {
      return { valid: false, args: value };
    }
  }

  if (value == null) {
    return { valid: true, args: {} };
  }

  return { valid: true, args: value };
};
