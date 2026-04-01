import type {
  ContentBlock,
  FinalizedContentBlock,
  MessageMetadata,
  MessageFinishData,
  MessagesEvent,
  UsageInfo,
} from "@langchain/protocol";

/**
 * Mutable view of a streamed message as message and content-block events are
 * assembled into a single structure.
 */
export interface AssembledMessage {
  namespace: string[];
  node?: string;
  messageId?: string;
  metadata?: MessageMetadata;
  blocks: ContentBlock[];
  usage?: UsageInfo;
  finishReason?: MessageFinishData["reason"];
  finishMetadata?: Record<string, any>;
  error?: {
    message: string;
    code?: string;
  };
}

/**
 * Emitted by `MessageAssembler.consume()` to describe how a message changed in
 * response to a single protocol event.
 */
export type MessageAssemblyUpdate =
  | {
      kind: "message-start";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    }
  | {
      kind: "content-block-start" | "content-block-delta";
      key: string;
      message: AssembledMessage;
      index: number;
      block: ContentBlock;
      event: MessagesEvent;
    }
  | {
      kind: "content-block-finish";
      key: string;
      message: AssembledMessage;
      index: number;
      block: FinalizedContentBlock;
      event: MessagesEvent;
    }
  | {
      kind: "message-finish";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    }
  | {
      kind: "message-error";
      key: string;
      message: AssembledMessage;
      event: MessagesEvent;
    };

/**
 * Clones a content block so assembly state can be mutated without retaining
 * references to the original protocol payload.
 *
 * @param block - Content block to clone.
 */
function cloneBlock<T extends ContentBlock>(block: T): T {
  return structuredClone(block);
}

/**
 * Ensures a content block slot exists before a delta is applied, filling any
 * missing indexes with cloned fallback blocks.
 *
 * @param blocks - Mutable block array for the message under construction.
 * @param index - Target content-block index to read or initialize.
 * @param fallback - Block used to initialize any missing slots.
 */
function ensureBlockIndex(
  blocks: ContentBlock[],
  index: number,
  fallback: ContentBlock
): ContentBlock {
  while (blocks.length <= index) {
    blocks.push(cloneBlock(fallback));
  }
  return blocks[index] ?? (blocks[index] = cloneBlock(fallback));
}

/**
 * Merges a streamed content delta into the current block state.
 *
 * @param target - Current block state accumulated for the content index.
 * @param delta - Incoming delta payload to merge into the block state.
 */
function applyContentDelta(
  target: ContentBlock,
  delta: ContentBlock
): ContentBlock {
  if (target.type !== delta.type) {
    return cloneBlock(delta);
  }

  switch (delta.type) {
    case "text":
      return {
        ...target,
        ...delta,
        text: `${"text" in target ? target.text : ""}${delta.text}`,
      };
    case "reasoning":
      return {
        ...target,
        ...delta,
        reasoning: `${"reasoning" in target ? target.reasoning : ""}${delta.reasoning}`,
      };
    case "tool_call_chunk":
    case "server_tool_call_chunk":
      return {
        ...target,
        ...delta,
        args: `${("args" in target ? target.args : "") ?? ""}${delta.args ?? ""}`,
      };
    default:
      return {
        ...target,
        ...delta,
      };
  }
}

/**
 * Derives the stable lookup key used to correlate all events for a single
 * streamed message.
 *
 * @param event - Message event used to derive the correlation key.
 */
function messageKeyFor(event: MessagesEvent): string {
  const { namespace, node, data } = event.params;
  const namespaceKey = namespace.join("/");
  const messageId =
    data.event === "message-start" ? (data.messageId ?? "") : "";
  return `${namespaceKey}::${node ?? ""}::${messageId}`;
}

/**
 * Incrementally assembles `messages` events into complete message objects.
 */
export class MessageAssembler {
  private readonly activeMessages = new Map<string, AssembledMessage>();
  private readonly activeByNamespaceNode = new Map<string, string>();

  /**
   * Applies a single message event and returns the resulting assembly update.
   *
   * @param event - Incoming `messages` event to fold into the assembler state.
   */
  consume(event: MessagesEvent): MessageAssemblyUpdate {
    const data = event.params.data;
    const namespaceNodeKey = `${event.params.namespace.join("/")}::${event.params.node ?? ""}`;

    if (data.event === "message-start") {
      const key = messageKeyFor(event);
      this.activeByNamespaceNode.set(namespaceNodeKey, key);
      const message: AssembledMessage = {
        namespace: [...event.params.namespace],
        node: event.params.node,
        messageId: data.messageId,
        metadata: data.metadata,
        blocks: [],
      };
      this.activeMessages.set(key, message);
      return { kind: "message-start", key, message, event };
    }

    const activeKey = this.activeByNamespaceNode.get(namespaceNodeKey);
    if (!activeKey) {
      throw new Error(
        `Received messages event ${data.event} before message-start for namespace ${namespaceNodeKey}`
      );
    }

    const message = this.activeMessages.get(activeKey);
    if (!message) {
      throw new Error(`No active message state found for key ${activeKey}`);
    }

    switch (data.event) {
      case "content-block-start": {
        message.blocks[data.index] = cloneBlock(data.contentBlock);
        return {
          kind: "content-block-start",
          key: activeKey,
          message,
          index: data.index,
          block: data.contentBlock,
          event,
        };
      }
      case "content-block-delta": {
        const current = ensureBlockIndex(
          message.blocks,
          data.index,
          data.contentBlock
        );
        message.blocks[data.index] = applyContentDelta(
          current,
          data.contentBlock
        );
        return {
          kind: "content-block-delta",
          key: activeKey,
          message,
          index: data.index,
          block: data.contentBlock,
          event,
        };
      }
      case "content-block-finish": {
        message.blocks[data.index] = cloneBlock(data.contentBlock);
        return {
          kind: "content-block-finish",
          key: activeKey,
          message,
          index: data.index,
          block: data.contentBlock,
          event,
        };
      }
      case "message-finish": {
        message.finishReason = data.reason;
        message.usage = data.usage;
        message.finishMetadata = data.metadata;
        this.activeMessages.delete(activeKey);
        this.activeByNamespaceNode.delete(namespaceNodeKey);
        return {
          kind: "message-finish",
          key: activeKey,
          message: structuredClone(message),
          event,
        };
      }
      case "error": {
        message.error = { message: data.message, code: data.code };
        this.activeMessages.delete(activeKey);
        this.activeByNamespaceNode.delete(namespaceNodeKey);
        return {
          kind: "message-error",
          key: activeKey,
          message: structuredClone(message),
          event,
        };
      }
    }
  }
}
