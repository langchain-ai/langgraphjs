export const serialiseAsDict = (obj: unknown) => {
  return JSON.stringify(obj, function (key: string | number, value: unknown) {
    const rawValue = this[key];
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

    return value;
  });
};

interface UnknownInterruptErrorLike extends Error {
  reason?: string;
  interruptIds?: string[];
  pendingIds?: string[];
}

// Matched by name: the graph may load its own copy of @langchain/langgraph.
export const isUnknownInterruptError = (
  error: unknown
): error is UnknownInterruptErrorLike =>
  error instanceof Error && error.name === "UnknownInterruptError";

export const serializeError = (error: unknown) => {
  if (isUnknownInterruptError(error)) {
    return {
      error: error.name,
      message: error.message,
      reason: error.reason,
      interrupt_ids: error.interruptIds,
      pending_ids: error.pendingIds,
    };
  }
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: JSON.stringify(error) };
};
