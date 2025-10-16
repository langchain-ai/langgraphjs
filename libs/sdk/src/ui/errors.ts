export class StreamError extends Error {
  constructor(data: { error?: string; name?: string; message: string }) {
    super(data.message);
    this.name = data.name ?? data.error ?? "StreamError";
  }

  static isStructuredError(error: unknown): error is {
    error?: string;
    name?: string;
    message: string;
  } {
    return typeof error === "object" && error != null && "message" in error;
  }
}
