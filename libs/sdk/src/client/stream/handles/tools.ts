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
 */
export interface AssembledToolCall {
  readonly name: string;
  readonly callId: string;
  readonly namespace: string[];
  readonly input: unknown;
  readonly output: Promise<unknown>;
  readonly status: Promise<ToolCallStatus>;
  readonly error: Promise<string | undefined>;
}

type ActiveToolCall = {
  name: string;
  callId: string;
  namespace: string[];
  input: unknown;
  resolveOutput: (value: unknown) => void;
  rejectOutput: (err: Error) => void;
  resolveStatus: (value: ToolCallStatus) => void;
  resolveError: (value: string | undefined) => void;
};

/**
 * Incrementally assembles `tools` events into complete
 * {@link AssembledToolCall} objects with promise-based output/status/error.
 *
 * Each `tool-started` event produces an {@link AssembledToolCall} whose
 * `output`, `status`, and `error` promises resolve when `tool-finished`
 * or `tool-error` arrives for the same `tool_call_id`.
 */
export class ToolCallAssembler {
  private readonly active = new Map<string, ActiveToolCall>();

  consume(event: ToolsEvent): AssembledToolCall | undefined {
    const data = event.params.data;

    if (data.event === "tool-started") {
      return this.handleStarted(event, data);
    }

    if (data.event === "tool-finished") {
      this.handleFinished(data);
      return undefined;
    }

    if (data.event === "tool-error") {
      this.handleError(data);
      return undefined;
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
      tc.resolveStatus("error");
      tc.resolveError(reason.message);
    }
    this.active.clear();
  }

  private handleStarted(
    event: ToolsEvent,
    data: ToolStartedData
  ): AssembledToolCall {
    let resolveOutput!: (value: unknown) => void;
    let rejectOutput!: (err: Error) => void;
    let resolveStatus!: (value: ToolCallStatus) => void;
    let resolveError!: (value: string | undefined) => void;

    const output = new Promise<unknown>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // Attach a default no-op catch so if no consumer awaits
    // `output` the eventual rejection on `tool-error` / `failAll`
    // doesn't surface as an unhandled Promise rejection.
    output.catch(() => undefined);
    const status = new Promise<ToolCallStatus>((resolve) => {
      resolveStatus = resolve;
    });
    const error = new Promise<string | undefined>((resolve) => {
      resolveError = resolve;
    });

    const entry: ActiveToolCall = {
      name: data.tool_name,
      callId: data.tool_call_id,
      namespace: [...event.params.namespace],
      input: data.input,
      resolveOutput,
      rejectOutput,
      resolveStatus,
      resolveError,
    };
    this.active.set(data.tool_call_id, entry);

    return {
      name: entry.name,
      callId: entry.callId,
      namespace: entry.namespace,
      input: entry.input,
      output,
      status,
      error,
    };
  }

  private handleFinished(data: ToolFinishedData): void {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return;
    this.active.delete(data.tool_call_id);
    entry.resolveOutput(data.output);
    entry.resolveStatus("finished");
    entry.resolveError(undefined);
  }

  private handleError(data: ToolErrorData): void {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return;
    this.active.delete(data.tool_call_id);
    entry.rejectOutput(new Error(data.message));
    entry.resolveStatus("error");
    entry.resolveError(data.message);
  }
}
