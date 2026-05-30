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

/** Shared metadata for assembled tool-call handles. */
interface ToolCallBase<TName extends string = string, TInput = unknown> {
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
}

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

/**
 * Reactive tool handle for framework bindings (`stream.toolCalls`,
 * `useToolCalls`, `injectToolCalls`).
 *
 * {@link status}, {@link error}, and {@link output} are plain values that
 * the assembler updates in place as tool events arrive. That lets React,
 * Vue, Svelte, and Angular re-render from a snapshot on each store tick
 * without `await`, effects, or Suspense boundaries around a promise.
 * {@link ClientAssembledToolCall} keeps a promise-based {@link output}
 * instead for script consumers that read tool results sequentially.
 *
 * {@link output} is `null` while the call is running or after it fails;
 * successful completion sets it to the parsed tool return value (objects
 * and strings are unwrapped from ToolMessage wire envelopes when needed).
 */
export interface AssembledToolCall<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> extends ToolCallBase<TName, TInput> {
  readonly output: TOutput | null;
  readonly status: ToolCallStatus;
  readonly error: string | undefined;
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

function getWireMessageField(message: unknown, field: string): unknown {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (field in record) return record[field];
  const kwargs = record.kwargs as Record<string, unknown> | undefined;
  if (kwargs != null && field in kwargs) return kwargs[field];
  const lcKwargs = record.lc_kwargs as Record<string, unknown> | undefined;
  if (lcKwargs != null && field in lcKwargs) return lcKwargs[field];
  return undefined;
}

function isToolMessageLike(
  value: unknown
): value is Record<string, unknown> & { content: unknown } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "tool") return true;
  const type = getWireMessageField(value, "type");
  if (type === "tool") return true;
  return (
    typeof getWireMessageField(value, "tool_call_id") === "string" &&
    getWireMessageField(value, "content") !== undefined
  );
}

function isCommandLike(
  value: unknown
): value is Record<string, unknown> & { update?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).lg_name === "Command"
  );
}

function textFromContentBlocks(content: unknown[]): string {
  let out = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      out += record.text;
    }
  }
  return out;
}

/**
 * Normalise tool-result `content` from a wire ToolMessage into the value
 * a tool implementation returned (object, string, etc.).
 */
function parseToolResultContent(content: unknown): unknown | null {
  if (content == null) return null;

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    return parseToolPayload(content);
  }

  if (Array.isArray(content)) {
    const text = textFromContentBlocks(content);
    if (text.length === 0) return null;
    return parseToolPayload(text);
  }

  if (typeof content === "object") {
    return content;
  }

  return null;
}

function parseToolMessageRecord(message: unknown): unknown | null {
  const content = getWireMessageField(message, "content");
  return parseToolResultContent(content);
}

type ParsedCommandToolOutput =
  | { found: true; value: unknown | null }
  | { found: false };

function parseCommandToolOutput(
  command: Record<string, unknown> & { update?: unknown },
  toolCallId?: string
): ParsedCommandToolOutput {
  const update = command.update;
  if (update == null || typeof update !== "object" || Array.isArray(update)) {
    return { found: false };
  }

  const messages = (update as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return { found: false };

  const toolMessages = messages.filter((message) => isToolMessageLike(message));
  if (toolMessages.length === 0) return { found: false };

  if (toolCallId != null) {
    for (const message of toolMessages) {
      const callId = getWireMessageField(message, "tool_call_id");
      if (callId !== toolCallId) continue;
      return { found: true, value: parseToolMessageRecord(message) };
    }
    return { found: false };
  }

  if (toolMessages.length === 1) {
    return { found: true, value: parseToolMessageRecord(toolMessages[0]) };
  }

  for (let i = toolMessages.length - 1; i >= 0; i -= 1) {
    const parsed = parseToolMessageRecord(toolMessages[i]);
    if (parsed != null) return { found: true, value: parsed };
  }

  return { found: true, value: null };
}

/**
 * Parse a `tool-finished` output payload into the tool's return value.
 *
 * Wire events often wrap structured tool results in a ToolMessage-shaped
 * object (`{ type: "tool", content: "..." }`) or a LangGraph
 * {@link Command} whose `update.messages` carries the ToolMessage.
 * This unwraps those envelopes, JSON-decodes string content when possible,
 * and leaves plain strings as-is. Returns `null` when a ToolMessage envelope
 * is present but its content cannot be normalised.
 */
export function parseToolOutput(
  value: unknown,
  toolCallId?: string
): unknown | null {
  const parsed = parseToolPayload(value);
  if (isCommandLike(parsed)) {
    const commandOutput = parseCommandToolOutput(parsed, toolCallId);
    return commandOutput.found ? commandOutput.value : parsed;
  }
  if (isToolMessageLike(parsed)) {
    return parseToolResultContent(getWireMessageField(parsed, "content"));
  }
  return parsed ?? null;
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
