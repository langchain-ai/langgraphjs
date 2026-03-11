const STRIP_EMPTY_ARRAY_KEYS = new Set([
  "tool_calls",
  "invalid_tool_calls",
  "tool_call_chunks",
]);

const STRIP_EMPTY_OBJECT_KEYS = new Set(["additional_kwargs"]);

export const serialiseAsDict = (obj: unknown) => {
  return JSON.stringify(
    obj,
    function (this: Record<string, unknown>, key: string | number, value: unknown) {
      const rawValue = this[key as string];
      if (
        rawValue != null &&
        typeof rawValue === "object" &&
        "toDict" in rawValue &&
        typeof rawValue.toDict === "function"
      ) {
        // TODO: we need to upstream this to LangChainJS
        const { type, data } = rawValue.toDict();
        return { ...data, type };
      }

      // Strip empty arrays for known message chunk defaults
      if (
        typeof key === "string" &&
        STRIP_EMPTY_ARRAY_KEYS.has(key) &&
        Array.isArray(value) &&
        value.length === 0
      ) {
        return undefined;
      }

      // Strip empty objects for known message chunk defaults
      if (
        typeof key === "string" &&
        STRIP_EMPTY_OBJECT_KEYS.has(key) &&
        typeof value === "object" &&
        value != null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
      ) {
        return undefined;
      }

      return value;
    },
    2
  );
};

export const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: JSON.stringify(error) };
};
