/**
 * Convert the protocol-native {@link AssembledMessage} (a namespace +
 * content-block bag) into a class instance from
 * `@langchain/core/messages`.
 *
 * The v2 messages channel carries `role` on the `message-start`
 * event, but `MessageAssembler` drops it by the time it produces an
 * `AssembledMessage`. The selector-side caller therefore captures the
 * role separately (via the assembler's per-update hook, see
 * `projections/messages.ts`) and passes it in.
 *
 * The conversion is intentionally lossless in the limit: when the
 * message finishes we emit the same BaseMessage shape that a
 * `values.messages` entry would round-trip to via
 * {@link tryCoerceMessageLikeToMessage}. Mid-stream, partial blocks
 * (e.g. tool_call_chunk) are folded into the same shape so the UI
 * can render an incrementally-completing message.
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { ContentBlock, MessageRole, UsageInfo } from "@langchain/protocol";
import type { AssembledMessage } from "../client/stream/messages.js";

export type ExtendedMessageRole = MessageRole | "tool";

export interface AssembledToMessageInput {
  /** Stable message id (from `MessageStartData.id`). */
  id?: string;
  /** Author role captured from the `message-start` event. */
  role: ExtendedMessageRole;
  /** Content blocks assembled so far. */
  blocks: ContentBlock[];
  /** Tool-call id a `role: "tool"` message is responding to, if any. */
  toolCallId?: string;
  /** Final-token usage (populated on `message-finish`). */
  usage?: UsageInfo;
}

/**
 * Produce a `BaseMessage` class instance from an in-progress or
 * finished assembled message. Safe to call repeatedly across deltas —
 * each call returns a new instance whose content reflects the
 * currently-observed blocks.
 */
export function assembledToBaseMessage(
  input: AssembledToMessageInput
): BaseMessage {
  const { id, role, blocks, toolCallId, usage } = input;
  const textContent = extractContentString(blocks);
  const toolCalls = extractToolCalls(blocks);
  const toolCallChunks = extractToolCallChunks(blocks);
  const additionalKwargs =
    usage != null ? ({ usage } as Record<string, unknown>) : undefined;

  switch (role) {
    case "human":
      return new HumanMessage({
        ...(id != null ? { id } : {}),
        content: textContent,
        ...(additionalKwargs != null
          ? { additional_kwargs: additionalKwargs }
          : {}),
      });
    case "system":
      return new SystemMessage({
        ...(id != null ? { id } : {}),
        content: textContent,
        ...(additionalKwargs != null
          ? { additional_kwargs: additionalKwargs }
          : {}),
      });
    case "tool":
      return new ToolMessage({
        ...(id != null ? { id } : {}),
        content: textContent,
        tool_call_id: toolCallId ?? "",
      });
    case "ai":
    default: {
      // Use `AIMessageChunk` whenever tool_call_chunks are present —
      // the concrete `AIMessage` class silently DROPS the
      // `tool_call_chunks` field, which would leave mid-stream tool
      // calls invisible to the UI (it sees an AI message with empty
      // content and no tool calls, rendering a blank bubble until
      // `content-block-finish` finally promotes the chunks to
      // finalized `tool_calls`). The chunk class is assignment-compatible
      // with `BaseMessage` and round-trips through the merge logic.
      const payload = {
        ...(id != null ? { id } : {}),
        content: cloneContentBlocks(blocks),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(toolCallChunks.length > 0
          ? { tool_call_chunks: toolCallChunks }
          : {}),
        ...(additionalKwargs != null
          ? { additional_kwargs: additionalKwargs }
          : {}),
        response_metadata: { output_version: "v1" as const },
      };
      return toolCallChunks.length > 0
        ? new AIMessageChunk(
            payload as ConstructorParameters<typeof AIMessageChunk>[0]
          )
        : new AIMessage(payload as ConstructorParameters<typeof AIMessage>[0]);
    }
  }
}

/**
 * Convenience: given the raw assembled message + the role captured
 * from `message-start`, produce a `BaseMessage` with the same id.
 */
export function assembledMessageToBaseMessage(
  assembled: AssembledMessage,
  role: ExtendedMessageRole,
  extras: { toolCallId?: string } = {}
): BaseMessage {
  return assembledToBaseMessage({
    id: assembled.id,
    role,
    blocks: assembled.blocks,
    toolCallId: extras.toolCallId,
    usage: assembled.usage,
  });
}

// ---------- helpers ----------

function extractContentString(blocks: ContentBlock[]): string {
  let out = "";
  for (const block of blocks) {
    if (
      block.type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

function cloneContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.map((block) => structuredClone(block));
}

interface LooseToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  type: "tool_call";
}

function extractToolCalls(blocks: ContentBlock[]): LooseToolCall[] {
  const out: LooseToolCall[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_call" && block.type !== "tool_use") continue;
    const tc = block as ToolCallLikeBlock;
    out.push({
      id: tc.id ?? "",
      name: tc.name ?? "",
      args: normalizeToolCallArgs(tc.args ?? tc.input),
      type: "tool_call",
    });
  }
  return out;
}

interface ToolCallLikeBlock {
  id?: string;
  name?: string;
  args?: unknown;
  input?: unknown;
}

interface LooseToolCallChunk {
  id?: string;
  name?: string;
  args?: string;
  index?: number;
  type: "tool_call_chunk";
}

function extractToolCallChunks(blocks: ContentBlock[]): LooseToolCallChunk[] {
  const out: LooseToolCallChunk[] = [];
  for (const block of blocks) {
    if (block.type === "tool_call_chunk") {
      const tc = block as {
        id?: string;
        name?: string;
        args?: string;
        index?: number;
      };
      out.push({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        index: tc.index,
        type: "tool_call_chunk",
      });
      continue;
    }
    if (block.type === "tool_call") {
      // WORKAROUND(@langchain/core AIMessageChunk constructor):
      // Re-encode finalized ``tool_call`` blocks as chunks. When a
      // streaming AI message has BOTH finalized and still-streaming
      // tool calls (parallel tool calls land sequentially during a
      // single message — block 1 finishes while blocks 2-N are still
      // streaming) the LangChain core ``AIMessageChunk`` constructor
      // drops the caller-supplied ``tool_calls`` field and rebuilds
      // it from ``tool_call_chunks`` via ``collapseToolCallChunks``.
      // Without this re-encoding, every finished tool call disappears
      // from ``message.tool_calls`` until ``message-finish`` flips
      // the message to a plain ``AIMessage`` — visible on the
      // coordinator panel as "only one Subagent Task card during
      // streaming, then four at the end".
      //
      // The ``tool_calls`` field at line 97 is therefore *also*
      // redundant on the chunk path: AIMessageChunk discards it. We
      // keep it for the no-chunks AIMessage branch below, where it's
      // still load-bearing.
      //
      // TODO: remove this branch once upstream preserves the caller
      // ``tool_calls`` field when ``tool_call_chunks`` is non-empty.
      // Args are assumed JSON-safe (LLM-emitted): NaN/Infinity/Date/
      // undefined will round-trip lossily through JSON.stringify ->
      // parsePartialJson. Cyclic or BigInt args trigger
      // safeJsonStringify's fallback and the call surfaces as an
      // invalid_tool_call with a marker args string.
      const tc = block as {
        id?: string;
        name?: string;
        args?: unknown;
        index?: number;
      };
      const argsString =
        tc.args != null &&
        typeof tc.args === "object" &&
        !Array.isArray(tc.args)
          ? safeJsonStringify(tc.args, tc.id)
          : typeof tc.args === "string"
            ? tc.args
            : "";
      out.push({
        id: tc.id,
        name: tc.name,
        args: argsString,
        index: tc.index,
        type: "tool_call_chunk",
      });
    }
  }
  return out;
}

function normalizeToolCallArgs(value: unknown): Record<string, unknown> {
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
      // Partial streaming input is represented via tool_call_chunks.
    }
  }
  return {};
}

function safeJsonStringify(value: unknown, toolCallId?: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    // Cyclic refs / BigInt / other JSON-hostile values surface here.
    // Returning "" lets ``parsePartialJson`` substitute ``"{}"`` and
    // produce a tool call with empty args — the call itself survives,
    // but a UI subagent card would render with no inputs. Warn so the
    // failure mode isn't silent.
    const id = toolCallId ? ` (tool_call id=${toolCallId})` : "";
    // oxlint-disable-next-line no-console
    console.warn(
      `[langgraph-sdk] failed to JSON-stringify finalized tool_call.args${id}; ` +
        `streaming UI will see empty args until message-finish: ${
          (error as { message?: string } | null)?.message ?? String(error)
        }`
    );
    return "";
  }
}
