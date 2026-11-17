import type {
  ToolsEvent,
  ToolStartedData,
  ToolFinishedData,
  ToolErrorData,
} from "@langchain/protocol";
import {
  parseToolOutput,
  parseToolPayload,
  type ToolCallBase,
  type ToolCallStatus,
} from "../../../ui/tool-payload.js";

/**
 * Script-oriented tool handle from the client SDK (`ThreadStream.toolCalls`,
 * subagent/subgraph projections). Completion and errors are surfaced only
 * through {@link output}.
 */
export interface ClientAssembledToolCall<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> extends ToolCallBase<TName, TInput> {
  readonly output: Promise<TOutput>;
}

/** @internal Mutable runtime handle shared by client and framework views. */
type MutableToolCallHandle = {
  name: string;
  callId: string;
  id: string;
  namespace: string[];
  input: unknown;
  args: unknown;
  output: unknown | null;
  status: ToolCallStatus;
  error: string | undefined;
  outputPromise: Promise<unknown>;
};

/**
 * Project a runtime handle to the client SDK surface (promise-only
 * {@link output}, no {@link status} / {@link error} fields).
 */
export function toClientAssembledToolCall(
  handle: MutableToolCallHandle
): ClientAssembledToolCall {
  return {
    name: handle.name,
    callId: handle.callId,
    id: handle.id,
    namespace: handle.namespace,
    input: handle.input,
    args: handle.args,
    output: handle.outputPromise as Promise<unknown>,
  };
}

/**
 * Skip wrapper `task` tool events scoped to a subagent namespace.
 *
 * Deep-agent subagents are discovered from root-level `task` tool calls;
 * replaying the same dispatch tool inside the worker namespace would
 * otherwise surface as a spurious entry in `sub.toolCalls`.
 */
export function shouldIgnoreScopedTaskToolEvent(
  scopeNamespace: readonly string[],
  event: ToolsEvent
): boolean {
  const data = event.params.data;
  return (
    scopeNamespace.length > 0 &&
    event.params.namespace.length === scopeNamespace.length &&
    event.params.namespace.every(
      (segment, index) => segment === scopeNamespace[index]
    ) &&
    "tool_name" in data &&
    data.tool_name === "task"
  );
}

type ActiveToolCall = {
  handle: MutableToolCallHandle;
  resolveOutput: (value: unknown) => void;
  rejectOutput: (err: Error) => void;
};

/**
 * Incrementally assembles `tools` events into mutable tool-call handles.
 *
 * Framework consumers store the handle directly; client SDK consumers
 * should map with {@link toClientAssembledToolCall} before yielding.
 */
export class ToolCallAssembler {
  private readonly active = new Map<string, ActiveToolCall>();

  consume(event: ToolsEvent): MutableToolCallHandle | undefined {
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
    for (const entry of this.active.values()) {
      entry.rejectOutput(reason);
      entry.handle.status = "error";
      entry.handle.error = reason.message;
    }
    this.active.clear();
  }

  private handleStarted(
    event: ToolsEvent,
    data: ToolStartedData
  ): MutableToolCallHandle {
    let resolveOutput!: (value: unknown) => void;
    let rejectOutput!: (err: Error) => void;

    const outputPromise = new Promise<unknown>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // Attach a default no-op catch so if no consumer awaits
    // `output` the eventual rejection on `tool-error` / `failAll`
    // doesn't surface as an unhandled Promise rejection.
    outputPromise.catch(() => undefined);

    const input = parseToolPayload(data.input);
    const name = data.tool_name;
    const callId = data.tool_call_id;
    const namespace = [...event.params.namespace];

    const handle: MutableToolCallHandle = {
      name,
      callId,
      id: callId,
      namespace,
      input,
      args: input,
      output: null,
      status: "running",
      error: undefined,
      outputPromise,
    };

    this.active.set(callId, {
      handle,
      resolveOutput,
      rejectOutput,
    });

    return handle;
  }

  private handleFinished(
    data: ToolFinishedData
  ): MutableToolCallHandle | undefined {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return undefined;
    this.active.delete(data.tool_call_id);
    const value = parseToolOutput(data.output, data.tool_call_id);
    entry.resolveOutput(value);
    entry.handle.output = value;
    entry.handle.status = "finished";
    entry.handle.error = undefined;
    return entry.handle;
  }

  private handleError(data: ToolErrorData): MutableToolCallHandle | undefined {
    const entry = this.active.get(data.tool_call_id);
    if (!entry) return undefined;
    this.active.delete(data.tool_call_id);
    entry.rejectOutput(new Error(data.message));
    entry.handle.output = null;
    entry.handle.status = "error";
    entry.handle.error = data.message;
    return entry.handle;
  }
}
