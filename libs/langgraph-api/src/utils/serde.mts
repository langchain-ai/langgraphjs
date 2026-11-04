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

export const serializeError = (error: unknown) => {
  // Matched by name: the graph may load its own copy of @langchain/langgraph.
  if (error instanceof Error && error.name === "UnknownInterruptError") {
    const { reason, interruptIds, pendingIds } = error as Error & {
      reason?: string;
      interruptIds?: string[];
      pendingIds?: string[];
    };
    return {
      error: error.name,
      message: error.message,
      reason,
      interrupt_ids: interruptIds,
      pending_ids: pendingIds,
    };
  }
  if (error instanceof Error) {
    return { error: error.name, message: error.message };
  }
  return { error: "Error", message: JSON.stringify(error) };
};
