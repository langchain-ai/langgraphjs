import type { Message } from "../types.messages.js";
import type { StreamEvent } from "../types.js";
import type { StreamMode } from "../types.stream.js";

type ProtocolChannel =
  | "values"
  | "updates"
  | "messages"
  | "tools"
  | "custom"
  | "lifecycle"
  | "input"
  | "debug"
  | "checkpoints"
  | "tasks";

type ProtocolEventMethod = ProtocolChannel | "input.requested";

type ProtocolSuccessResponse = {
  type: "success";
  id: number;
  result: Record<string, unknown>;
  meta?: {
    threadId?: string;
    appliedThroughSeq?: number;
  };
};

type ProtocolErrorResponse = {
  type: "error";
  id: number | null;
  error: string;
  message: string;
};

export type ProtocolCommandResponse =
  | ProtocolSuccessResponse
  | ProtocolErrorResponse;

export type ProtocolEventMessage = {
  type: "event";
  eventId?: string;
  seq?: number;
  method: ProtocolEventMethod;
  params: {
    namespace: string[];
    timestamp: number;
    data: unknown;
    node?: string;
  };
};

type AdaptedStreamEvent = {
  id?: string;
  event: StreamEvent;
  data: unknown;
};

type ProtocolMessageState = {
  id: string;
  metadata?: Record<string, unknown>;
  messageType?: "ai" | "human" | "system" | "function" | "remove";
  emittedChunks: number;
  textByIndex: Map<number, string>;
  reasoningByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  toolMetaByIndex: Map<number, { id?: string; name?: string }>;
};

const PROTOCOL_STREAM_MODE_TO_CHANNEL = {
  values: "values",
  updates: "updates",
  custom: "custom",
  debug: "debug",
  tasks: "tasks",
  checkpoints: "checkpoints",
  tools: "tools",
  "messages-tuple": "messages",
} as const satisfies Partial<Record<StreamMode, ProtocolChannel>>;

export const PROTOCOL_SSE_SUPPORTED_STREAM_MODES = new Set<StreamMode>(
  Object.keys(PROTOCOL_STREAM_MODE_TO_CHANNEL) as StreamMode[]
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const toNamespacedEvent = (event: StreamEvent, namespace: string[]) =>
  namespace.length > 0
    ? (`${event}|${namespace.join("|")}` as StreamEvent)
    : event;

const toScopeKey = (namespace: string[], node?: string) =>
  `${namespace.join("\0")}\0${node ?? ""}`;

const toMessageMetadata = (
  namespace: string[],
  node?: string,
  metadata?: Record<string, unknown>
) => {
  const tags = Array.isArray(metadata?.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const checkpointNs = namespace.length > 0 ? namespace.join("|") : undefined;

  return {
    ...metadata,
    tags,
    ...(node != null ? { langgraph_node: node } : {}),
    ...(checkpointNs != null
      ? {
          langgraph_checkpoint_ns: checkpointNs,
          checkpoint_ns: checkpointNs,
        }
      : {}),
  };
};

const toUsageMetadata = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.input_tokens === "number"
      ? { input_tokens: value.input_tokens }
      : {}),
    ...(typeof value.output_tokens === "number"
      ? { output_tokens: value.output_tokens }
      : {}),
    ...(typeof value.total_tokens === "number"
      ? { total_tokens: value.total_tokens }
      : {}),
    ...(typeof value.cached_tokens === "number"
      ? { input_token_details: { cache_read: value.cached_tokens } }
      : {}),
  };
};

const normalizeToolArgs = (value: string | undefined) => {
  if (value == null) return { parsed: undefined, invalid: false };
  if (value === "") return { parsed: {}, invalid: false };
  try {
    return {
      parsed: JSON.parse(value) as unknown,
      invalid: false,
    };
  } catch {
    return {
      parsed: undefined,
      invalid: true,
    };
  }
};

const createAiChunk = (
  messageId: string,
  fields: Record<string, unknown>
): Message =>
  ({
    type: "ai",
    id: messageId,
    content: "",
    additional_kwargs: {},
    response_metadata: {},
    tool_call_chunks: [],
    tool_calls: [],
    invalid_tool_calls: [],
    ...fields,
  }) as Message;

const getProtocolMessageTypeFromMessageId = (
  messageId: string
): ProtocolMessageState["messageType"] => {
  if (messageId.endsWith(":human")) return "human";
  if (messageId.endsWith(":system")) return "system";
  if (messageId.endsWith(":function")) return "function";
  if (messageId.endsWith(":remove")) return "remove";
  if (messageId.endsWith(":ai")) return "ai";
  return undefined;
};

const createMessageChunk = (
  messageId: string,
  messageType: ProtocolMessageState["messageType"],
  fields: Record<string, unknown>
): Message => {
  const base = {
    id: messageId,
    content: "",
    additional_kwargs: {},
    response_metadata: {},
    ...fields,
  };

  switch (messageType) {
    case "human":
      return {
        type: "human",
        ...base,
      } as Message;
    case "system":
      return {
        type: "system",
        ...base,
      } as Message;
    case "function":
      return {
        type: "function",
        ...base,
      } as Message;
    case "remove":
      return {
        type: "remove",
        ...base,
      } as Message;
    default:
      return createAiChunk(messageId, fields);
  }
};

const asProtocolChannel = (mode: StreamMode): ProtocolChannel | undefined =>
  mode in PROTOCOL_STREAM_MODE_TO_CHANNEL
    ? PROTOCOL_STREAM_MODE_TO_CHANNEL[
        mode as keyof typeof PROTOCOL_STREAM_MODE_TO_CHANNEL
      ]
    : undefined;

export function getProtocolChannels(streamMode?: StreamMode | StreamMode[]) {
  const modes = Array.isArray(streamMode)
    ? streamMode
    : streamMode != null
      ? [streamMode]
      : (["values"] as StreamMode[]);

  const channels = new Set<ProtocolChannel>(["lifecycle", "input"]);
  for (const mode of modes) {
    const channel = asProtocolChannel(mode);
    if (channel != null) channels.add(channel);
  }

  return [...channels];
}

export function canUseProtocolSse(streamMode?: StreamMode | StreamMode[]) {
  const modes = Array.isArray(streamMode)
    ? streamMode
    : streamMode != null
      ? [streamMode]
      : (["values"] as StreamMode[]);
  return modes.every((mode) => PROTOCOL_SSE_SUPPORTED_STREAM_MODES.has(mode));
}

export function isProtocolErrorResponse(
  value: ProtocolCommandResponse
): value is ProtocolErrorResponse {
  return value.type === "error";
}

export class ProtocolEventAdapter {
  private readonly activeMessageByScope = new Map<string, string>();

  private readonly messageState = new Map<string, ProtocolMessageState>();

  adapt(event: ProtocolEventMessage): AdaptedStreamEvent[] {
    const { namespace, node, data } = event.params;

    switch (event.method) {
      case "values":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("values", namespace),
            data,
          },
        ];
      case "updates":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("updates", namespace),
            data:
              node != null && isRecord(data)
                ? { [node]: data }
                : node != null
                  ? { [node]: data }
                  : data,
          },
        ];
      case "custom":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("custom", namespace),
            data: isRecord(data) && "payload" in data ? data.payload : data,
          },
        ];
      case "debug":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("debug", namespace),
            data,
          },
        ];
      case "tasks":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("tasks", namespace),
            data,
          },
        ];
      case "checkpoints":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("checkpoints", namespace),
            data,
          },
        ];
      case "tools":
        return [
          {
            id: event.eventId,
            event: toNamespacedEvent("tools", namespace),
            data: this.toLegacyToolEvent(data),
          },
        ];
      case "lifecycle":
        return this.toLegacyLifecycleEvent(event);
      case "input.requested":
        return this.toInputEvent(event);
      case "messages":
        return this.toLegacyMessageEvents(event);
      default:
        return [];
    }
  }

  private toLegacyLifecycleEvent(
    event: ProtocolEventMessage
  ): AdaptedStreamEvent[] {
    const data = event.params.data;
    if (!isRecord(data) || data.event !== "failed") return [];
    return [
      {
        id: event.eventId,
        event: "error",
        data: {
          error: "ProtocolRunError",
          message:
            typeof data.error === "string"
              ? data.error
              : "Protocol run failed.",
        },
      },
    ];
  }

  private toLegacyToolEvent(data: unknown) {
    if (!isRecord(data) || typeof data.event !== "string") {
      return {
        event: "on_tool_event",
        data,
      };
    }

    switch (data.event) {
      case "tool-started":
        return {
          event: "on_tool_start",
          name: data.toolName,
          input: data.input,
          toolCallId: data.toolCallId,
        };
      case "tool-output-delta":
        return {
          event: "on_tool_event",
          data: data.delta,
          toolCallId: data.toolCallId,
        };
      case "tool-finished":
        return {
          event: "on_tool_end",
          output: data.output,
          toolCallId: data.toolCallId,
        };
      case "tool-error":
        return {
          event: "on_tool_error",
          error: data.message,
          toolCallId: data.toolCallId,
        };
      default:
        return {
          event: "on_tool_event",
          data,
          toolCallId: data.toolCallId,
        };
    }
  }

  private toInputEvent(event: ProtocolEventMessage): AdaptedStreamEvent[] {
    const data = event.params.data;
    if (!isRecord(data) || typeof data.interruptId !== "string") {
      return [];
    }

    return [
      {
        id: event.eventId,
        event: toNamespacedEvent("input", event.params.namespace),
        data: {
          interruptId: data.interruptId,
          payload: "payload" in data ? data.payload : undefined,
        },
      },
    ];
  }

  private toLegacyMessageEvents(
    event: ProtocolEventMessage
  ): AdaptedStreamEvent[] {
    const { namespace, node, data } = event.params;
    if (!isRecord(data) || typeof data.event !== "string") return [];

    const scopeKey = toScopeKey(namespace, node);
    const activeMessageId = this.activeMessageByScope.get(scopeKey);
    const state =
      activeMessageId != null
        ? this.messageState.get(activeMessageId)
        : undefined;

    switch (data.event) {
      case "message-start": {
        const messageId =
          typeof data.messageId === "string"
            ? data.messageId
            : `${scopeKey}:${event.eventId ?? Date.now()}`;
        this.activeMessageByScope.set(scopeKey, messageId);
        this.messageState.set(messageId, {
          id: messageId,
          metadata: isRecord(data.metadata)
            ? (data.metadata as Record<string, unknown>)
            : undefined,
          messageType: getProtocolMessageTypeFromMessageId(messageId),
          emittedChunks: 0,
          textByIndex: new Map(),
          reasoningByIndex: new Map(),
          toolArgsByIndex: new Map(),
          toolMetaByIndex: new Map(),
        });
        return [];
      }
      case "content-block-start":
      case "content-block-delta":
      case "content-block-finish":
        if (
          state == null ||
          typeof data.index !== "number" ||
          !isRecord(data.contentBlock)
        ) {
          return [];
        }
        return this.toLegacyContentBlockEvent(
          event,
          state,
          namespace,
          node,
          data.event,
          data.index,
          data.contentBlock
        );
      case "message-finish": {
        if (state == null) return [];
        this.activeMessageByScope.delete(scopeKey);
        this.messageState.delete(state.id);
        const metadata = toMessageMetadata(namespace, node, state.metadata);
        const usage = toUsageMetadata(data.usage);
        if (
          state.emittedChunks === 0 ||
          usage != null ||
          isRecord(data.metadata) ||
          typeof data.reason === "string"
        ) {
          return [
            this.createMessageTupleEvent(
              event.eventId,
              namespace,
              createMessageChunk(state.id, state.messageType, {
                content: [],
                response_metadata: isRecord(data.metadata) ? data.metadata : {},
                usage_metadata: usage,
                additional_kwargs:
                  typeof data.reason === "string"
                    ? { stop_reason: data.reason }
                    : {},
              }),
              metadata
            ),
          ];
        }
        return [];
      }
      case "error": {
        this.activeMessageByScope.delete(scopeKey);
        if (state != null) this.messageState.delete(state.id);
        return [
          {
            id: event.eventId,
            event: "error",
            data: {
              error: "ProtocolMessageError",
              message:
                typeof data.message === "string"
                  ? data.message
                  : "Protocol message stream failed.",
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  private toLegacyContentBlockEvent(
    event: ProtocolEventMessage,
    state: ProtocolMessageState,
    namespace: string[],
    node: string | undefined,
    phase:
      | "content-block-start"
      | "content-block-delta"
      | "content-block-finish",
    index: number,
    contentBlock: Record<string, unknown>
  ): AdaptedStreamEvent[] {
    const metadata = toMessageMetadata(namespace, node, state.metadata);
    const blockType =
      typeof contentBlock.type === "string" ? contentBlock.type : undefined;
    if (blockType == null) return [];

    if (blockType === "text") {
      const nextText =
        typeof contentBlock.text === "string" ? contentBlock.text : "";
      const previousText = state.textByIndex.get(index) ?? "";

      let delta = "";
      if (phase === "content-block-delta") {
        delta = nextText;
        state.textByIndex.set(index, previousText + nextText);
      } else if (
        phase === "content-block-finish" &&
        nextText.startsWith(previousText)
      ) {
        delta = nextText.slice(previousText.length);
        state.textByIndex.set(index, nextText);
      } else if (phase !== "content-block-start") {
        delta = nextText;
        state.textByIndex.set(index, nextText);
      }

      if (delta.length === 0) return [];
      return [
        this.createMessageTupleEvent(
          event.eventId,
          namespace,
          createMessageChunk(state.id, state.messageType, { content: delta }),
          metadata
        ),
      ];
    }

    if (blockType === "reasoning") {
      const nextReasoning =
        typeof contentBlock.reasoning === "string"
          ? contentBlock.reasoning
          : "";
      const previousReasoning = state.reasoningByIndex.get(index) ?? "";

      let delta = "";
      if (phase === "content-block-delta") {
        delta = nextReasoning;
        state.reasoningByIndex.set(index, previousReasoning + nextReasoning);
      } else if (
        phase === "content-block-finish" &&
        nextReasoning.startsWith(previousReasoning)
      ) {
        delta = nextReasoning.slice(previousReasoning.length);
        state.reasoningByIndex.set(index, nextReasoning);
      } else if (phase !== "content-block-start") {
        delta = nextReasoning;
        state.reasoningByIndex.set(index, nextReasoning);
      }

      if (delta.length === 0) return [];
      return [
        this.createMessageTupleEvent(
          event.eventId,
          namespace,
          createMessageChunk(state.id, state.messageType, {
            content: [{ type: "reasoning", reasoning: delta }],
          }),
          metadata
        ),
      ];
    }

    if (blockType === "tool_call_chunk") {
      const argsText =
        typeof contentBlock.args === "string" ? contentBlock.args : "";
      const previousArgs = state.toolArgsByIndex.get(index) ?? "";
      const mergedArgs =
        phase === "content-block-delta"
          ? `${previousArgs}${argsText}`
          : argsText;
      const toolId =
        typeof contentBlock.id === "string"
          ? contentBlock.id
          : state.toolMetaByIndex.get(index)?.id;
      const toolName =
        typeof contentBlock.name === "string"
          ? contentBlock.name
          : state.toolMetaByIndex.get(index)?.name;
      const parsed = normalizeToolArgs(mergedArgs);

      state.toolArgsByIndex.set(index, mergedArgs);
      state.toolMetaByIndex.set(index, { id: toolId, name: toolName });

      const content =
        phase === "content-block-start"
          ? [
              {
                index,
                type: "tool_use",
                ...(toolId != null ? { id: toolId } : {}),
                ...(toolName != null ? { name: toolName } : {}),
                input: parsed.invalid ? "" : (parsed.parsed ?? ""),
              },
            ]
          : [
              {
                index,
                type: "input_json_delta",
                input: argsText,
              },
            ];

      return [
        this.createMessageTupleEvent(
          event.eventId,
          namespace,
          createAiChunk(state.id, {
            content,
            tool_call_chunks: [
              {
                index,
                type: "tool_call_chunk",
                ...(toolId != null ? { id: toolId } : {}),
                ...(toolName != null ? { name: toolName } : {}),
                args: argsText,
              },
            ],
            tool_calls:
              !parsed.invalid && toolName != null
                ? [
                    {
                      name: toolName,
                      args: parsed.parsed ?? {},
                      ...(toolId != null ? { id: toolId } : {}),
                      type: "tool_call",
                    },
                  ]
                : [],
            invalid_tool_calls: parsed.invalid
              ? [
                  {
                    name: toolName ?? "",
                    args: mergedArgs,
                    ...(toolId != null ? { id: toolId } : {}),
                    error: "Malformed args.",
                    type: "invalid_tool_call",
                  },
                ]
              : [],
          }),
          metadata
        ),
      ];
    }

    if (blockType === "tool_call") {
      if (state.toolArgsByIndex.has(index)) return [];
      if (typeof contentBlock.name !== "string") return [];
      return [
        this.createMessageTupleEvent(
          event.eventId,
          namespace,
          createAiChunk(state.id, {
            content: [
              {
                index,
                type: "tool_use",
                ...(typeof contentBlock.id === "string"
                  ? { id: contentBlock.id }
                  : {}),
                name: contentBlock.name,
                input: contentBlock.args ?? {},
              },
            ],
            tool_calls: [
              {
                name: contentBlock.name,
                args: contentBlock.args ?? {},
                ...(typeof contentBlock.id === "string"
                  ? { id: contentBlock.id }
                  : {}),
                type: "tool_call",
              },
            ],
          }),
          metadata
        ),
      ];
    }

    if (blockType === "invalid_tool_call") {
      return [
        this.createMessageTupleEvent(
          event.eventId,
          namespace,
          createAiChunk(state.id, {
            invalid_tool_calls: [
              {
                ...(typeof contentBlock.name === "string"
                  ? { name: contentBlock.name }
                  : {}),
                ...(typeof contentBlock.args === "string"
                  ? { args: contentBlock.args }
                  : {}),
                ...(typeof contentBlock.id === "string"
                  ? { id: contentBlock.id }
                  : {}),
                ...(typeof contentBlock.error === "string"
                  ? { error: contentBlock.error }
                  : {}),
                type: "invalid_tool_call",
              },
            ],
          }),
          metadata
        ),
      ];
    }

    if (phase === "content-block-start") return [];

    return [
      this.createMessageTupleEvent(
        event.eventId,
        namespace,
        createAiChunk(state.id, {
          content: [{ index, ...contentBlock }],
        }),
        metadata
      ),
    ];
  }

  private createMessageTupleEvent(
    id: string | undefined,
    namespace: string[],
    chunk: Message,
    metadata: Record<string, unknown>
  ): AdaptedStreamEvent {
    const namespacedEvent = toNamespacedEvent("messages", namespace);
    return {
      id,
      event: namespacedEvent,
      data: [chunk, metadata],
    };
  }
}
