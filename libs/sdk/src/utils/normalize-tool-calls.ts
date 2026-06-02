export type NormalizedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: "tool_call";
};

export function normalizeToolCallArgs(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Streaming input fragments are expected to be invalid until finalized.
    }
  }
  return {};
}

/**
 * Map a provider-native content or output block to a LangChain tool call.
 *
 * Handles standard LangChain/Anthropic blocks (`tool_call`, `tool_use`) and
 * OpenAI Responses API blocks (`function_call` with `call_id` + `arguments`).
 */
export function toolCallFromProviderBlock(
  block: unknown
): NormalizedToolCall | null {
  if (block == null || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;

  if (record.type === "tool_call" || record.type === "tool_use") {
    return {
      id: String(record.id ?? ""),
      name: String(record.name ?? ""),
      args: normalizeToolCallArgs(record.args ?? record.input),
      type: "tool_call",
    };
  }

  if (record.type === "function_call") {
    const argsString =
      typeof record.arguments === "string" ? record.arguments : "{}";
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsString) as Record<string, unknown>;
    } catch {
      args = { raw: argsString };
    }
    return {
      id: String(record.call_id ?? record.id ?? ""),
      name: String(record.name ?? "unknown"),
      args,
      type: "tool_call",
    };
  }

  return null;
}

export function extractToolCallsFromBlocks(
  blocks: unknown
): NormalizedToolCall[] {
  if (!Array.isArray(blocks)) return [];
  const out: NormalizedToolCall[] = [];
  for (const block of blocks) {
    const toolCall = toolCallFromProviderBlock(block);
    if (toolCall != null) out.push(toolCall);
  }
  return out;
}

/**
 * Remove provider-native tool call blocks from message content after they
 * have been promoted to top-level `tool_calls`.
 */
export function stripProviderToolCallBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => {
    if (block == null || typeof block !== "object") return true;
    const type = (block as { type?: unknown }).type;
    return type !== "function_call";
  });
}

/**
 * Normalize tool calls on a plain serialized AI message dict before
 * constructing an `AIMessage` instance.
 */
export function normalizePlainAIMessageFields<
  T extends Record<string, unknown>,
>(message: T): T {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message;
  }

  const additionalKwargs = message.additional_kwargs as
    | Record<string, unknown>
    | undefined;
  const legacyToolCalls = additionalKwargs?.tool_calls;
  if (Array.isArray(legacyToolCalls) && legacyToolCalls.length > 0) {
    return { ...message, tool_calls: legacyToolCalls };
  }

  let toolCalls = extractToolCallsFromBlocks(message.content);
  if (toolCalls.length === 0) {
    const responseMetadata = message.response_metadata as
      | { output?: unknown }
      | undefined;
    if (Array.isArray(responseMetadata?.output)) {
      toolCalls = extractToolCallsFromBlocks(responseMetadata.output);
    }
  }

  if (toolCalls.length === 0) return message;

  return {
    ...message,
    tool_calls: toolCalls,
    content: stripProviderToolCallBlocks(message.content),
  };
}
