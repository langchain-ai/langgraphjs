/**
 * High-level outcome of a single tool call.
 */
export type ToolCallStatus = "running" | "finished" | "error";

/** Shared metadata for assembled tool-call handles. */
export interface ToolCallBase<TName extends string = string, TInput = unknown> {
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
 * Reactive tool handle for framework bindings (`stream.toolCalls`,
 * `useToolCalls`, `injectToolCalls`).
 *
 * {@link status}, {@link error}, and {@link output} are plain values that
 * the assembler updates in place as tool events arrive. That lets React,
 * Vue, Svelte, and Angular re-render from a snapshot on each store tick
 * without `await`, effects, or Suspense boundaries around a promise.
 * The client SDK's `ClientAssembledToolCall` keeps a promise-based
 * {@link output} instead for script consumers that read tool results
 * sequentially.
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
