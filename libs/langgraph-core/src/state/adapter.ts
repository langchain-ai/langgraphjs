/**
 * Adapter utilities for working with Standard Schema.
 */
import type { SerializableSchema } from "./types.js";
import { isStandardJSONSchema, isStandardSchema } from "./types.js";

/**
 * Get the JSON schema from a SerializableSchema.
 */
export function getJsonSchemaFromSchema(
  schema: SerializableSchema | unknown
): Record<string, unknown> | undefined {
  if (isStandardJSONSchema(schema)) {
    try {
      const standard = schema["~standard"];
      return standard.jsonSchema.input({ target: "draft-07" });
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Detect if a schema has a default value by validating `undefined`.
 *
 * Uses the Standard Schema `~standard.validate` API to detect defaults.
 * If the schema accepts `undefined` and returns a value, that value is the default.
 *
 * This approach is library-agnostic and works with any Standard Schema compliant
 * library (Zod, Valibot, ArkType, etc.) without needing to introspect internals.
 *
 * @param schema - The schema to check for a default value.
 * @returns A factory function returning the default, or undefined if no default exists.
 *
 * @example
 * ```ts
 * const getter = getSchemaDefaultGetter(z.string().default("hello"));
 * getter?.(); // "hello"
 *
 * const noDefault = getSchemaDefaultGetter(z.string());
 * noDefault; // undefined
 * ```
 */
export function getSchemaDefaultGetter(
  schema: SerializableSchema | unknown
): (() => unknown) | undefined {
  if (schema == null) {
    return undefined;
  }

  if (!isStandardSchema(schema)) {
    return undefined;
  }

  try {
    const result = schema["~standard"].validate(undefined);

    // Handle sync result (not a Promise)
    // Default values are always synchronous - async validation only happens
    // with async refinements, which don't affect default value resolution.
    if (
      result &&
      typeof result === "object" &&
      !("then" in result && typeof result.then === "function")
    ) {
      const syncResult = result as { issues?: unknown; value?: unknown };
      if (!syncResult.issues) {
        const defaultValue = syncResult.value;
        return () => defaultValue;
      }
    }
  } catch {
    // Validation threw - no default
  }

  return undefined;
}
