import type {
  ToolsEvent,
  ToolStartedData,
  ToolFinishedData,
  ToolErrorData,
} from "@langchain/protocol";

/**
 * High-level outcome of a single tool call.
 */
export type ToolCallStatus = "running" | "finished" | "error";

/**
 * Assembled view of a single tool call lifecycle (`tool-started` →
 * optional `tool-output-delta` → `tool-finished` | `tool-error`).
 *
 * Mirrors the in-process `ToolCallStream` interface so that remote
 * consumers get the same ergonomics.
 *
 * @typeParam TName - Registered tool name.
 * @typeParam TInput - Parsed tool arguments.
 * @typeParam TOutput - Successful tool return value.
 */
export interface AssembledToolCall<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> {
  readonly name: TName;
  readonly callId: string;
  /**
   * Pre-v1 alias for {@link callId}. Matches `ToolCallWithResult.id` and
   * `ToolCall.id` on message-level tool calls.
   */
  readonly id: string;
  readonly namespace: string[];
  readonly input: TInput;
  /**
   * Pre-v1 alias for {@link input}. Matches `ToolCallFromTool` `args`.
   */
  readonly args: TInput;
  readonly output: Promise<TOutput>;
  /** `"running"` from `tool-started` until `tool-finished` or `tool-error`. */
  readonly status: ToolCallStatus;
  /** Set when {@link status} is `"error"`, otherwise `undefined`. */
  readonly error: string | undefined;
}

/** @internal Mutable handle returned by {@link ToolCallAssembler}. */
type MutableAssembledToolCall = AssembledToolCall & {
  status: ToolCallStatus;
  error: string | undefined;
};

/**
 * Parse wire-format tool payloads into structured values.
 *
 * Tool events may carry JSON-encoded object strings on the wire; this
 * helper normalises them to plain objects for consumers. Non-JSON strings
 * are returned unchanged.
 */
export function parseToolPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

type ActiveToolCall = {
  assembled: MutableAssembledToolCall;
  resolveOutput: (value: unknown) => void;
  rejectOutput: (err: Error) => void;
};

/**
 * Incrementally assembles `tools` events into complete
 * {@link AssembledToolCall} objects.
 *
 * Each `tool-started` event produces an {@link AssembledToolCall} whose
 * `status` starts as `"running"` and updates in place on
 * `tool-finished` / `tool-error`. The `output` promise resolves or
 * rejects when the call completes.
 */
export class ToolCallAssembler {
  private readonly active = new Map<string, ActiveToolCall>();

  consume(event: ToolsEvent): AssembledToolCall | undefined {
    const data = event.params.data;

    if (data.event === "tool-started") {
      return this.handleStarted(event, data);
    }

    if (data.event === "tool-finished") {
      return this.handleFinished(data);
    }

    if (data.event === "tool-error") {
      return this.handleError(data);
    }

    // tool-output-delta: no action needed at assembly level
    return undefined;
  }

  /**
   * Reject any in-flight tool calls (e.g. on session close).
   */
  failAll(reason: Error): void {
    for (const tc of this.active.values()) {
      tc.rejectOutput(reason);
      tc.assembled.status = "error";
      tc.assembled.error = reason.message;
    }
    this.active.clear();
  }

  private handleStarted(
    event: ToolsEvent,
    data: ToolStartedData
  ): AssembledToolCall {
    let resolveOutput!: (value: unknown) => void;
    let rejectOutput!: (err: Error) => void;

    const output = new Promise<unknown>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // Attach a default no-op catch so if no consumer awaits
    // `output` the eventual rejection on `tool-error` / `failAll`
    // doesn't surface as an unhandled Promise rejection.
    output.catch(() => undefined);

    const input = parseToolPayload(data.input);
    const name = data.tool_name;
    const callId = data.tool_call_id;
    const namespace = [...event.params.namespace];

    const assembled: MutableAssembledToolCall = {
      name,
      callId,
      id: callId,
      namespace,
      input,
      args: input,
      output,
      status: "running",
      error: undefined,
    };

    this.active.set(callId, {
      assembled,
      resolveOutput,
      rejectOutput,
    });

    return assembled;
  }

  private handleFinished(
    data: ToolFinishedData
  ): AssembledToolCall | undefined {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return undefined;
    this.active.delete(data.tool_call_id);
    entry.resolveOutput(parseToolPayload(data.output));
    entry.assembled.status = "finished";
    entry.assembled.error = undefined;
    return entry.assembled;
  }

  private handleError(data: ToolErrorData): AssembledToolCall | undefined {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return undefined;
    this.active.delete(data.tool_call_id);
    entry.rejectOutput(new Error(data.message));
    entry.assembled.status = "error";
    entry.assembled.error = data.message;
    return entry.assembled;
  }
}
