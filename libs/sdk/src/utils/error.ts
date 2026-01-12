export const isError = (error: unknown): error is Error => {
  // check for presence of `Error.isError` for newer browsers
  if ("isError" in Error && typeof Error.isError === "function") {
    return Error.isError(error);
  }

  // Resort to checking string tag
  const stringTag = Object.prototype.toString.call(error);
  return (
    stringTag === "[object Error]" ||
    stringTag === "[object DOMException]" ||
    stringTag === "[object DOMError]" ||
    stringTag === "[object Exception]"
  );
};

export const isNetworkError = (error: unknown): error is Error => {
  if (!isError(error)) return false;
  if (error.name !== "TypeError" || typeof error.message !== "string") {
    return false;
  }
  const msg = error.message.toLowerCase();
  const { cause } = error as { cause?: unknown };
  const { message: causeMessage } = (cause ?? {}) as { message?: string };
  const normalizedCauseMessage =
    typeof causeMessage === "string" ? causeMessage.toLowerCase() : "";
  return (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("connection") ||
    msg.includes("error sending request") ||
    msg.includes("load failed") ||
    msg.includes("terminated") ||
    normalizedCauseMessage.includes("other side closed") ||
    normalizedCauseMessage.includes("socket")
  );
};
