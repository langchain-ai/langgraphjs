/**
 * Type tests for message class instances in @langchain/svelte.
 *
 * These tests validate that `useStream` from @langchain/svelte exposes
 * @langchain/core message class instances (BaseMessage) rather than
 * plain SDK Message interfaces.
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles them
 * to verify type correctness.
 */

import { describe, test, expectTypeOf } from "vitest";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { Message } from "@langchain/langgraph-sdk";
import {
  getStream,
  provideStream,
  useAudio,
  useAudioPlayer,
  useChannel,
  useExtension,
  useFiles,
  useImages,
  useMessageMetadata,
  useMediaURL,
  useMessages,
  useSubmissionQueue,
  useStream,
  useToolCalls,
  useValues,
  useVideo,
  useVideoPlayer,
  type AgentServerOptions,
  type AnyStream,
  type AssembledToolCall,
  type AudioMedia,
  type AudioPlayerHandle,
  type Channel,
  type CustomAdapterOptions,
  type Event,
  type FileMedia,
  type ImageMedia,
  type MessageMetadata,
  type PlayerStatus,
  type SelectorTarget,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type SubmissionQueueSnapshot,
  type UseStreamOptions,
  type UseStreamReturn,
  type UseSubmissionQueueReturn,
  type VideoMedia,
  type VideoPlayerHandle,
  type WidenUpdateMessages,
} from "../index.js";

// ============================================================================
// Test State Types
// ============================================================================

interface BasicState {
  messages: Message[];
}

interface CustomState {
  messages: Message[];
  sessionId: string;
  metadata: { theme: "light" | "dark" };
}

interface BedtimeState {
  messages: BaseMessage[];
  paragraphs: string[];
  theme: "light" | "dark";
}

interface ApprovalRequest {
  prompt: string;
  options: readonly string[];
}

interface TenantConfig {
  tenantId: string;
  region: "us" | "eu";
}

interface SubagentValues {
  summary: string;
  confidence: number;
}

declare const typedStream: UseStreamReturn<
  BedtimeState,
  ApprovalRequest,
  TenantConfig
>;
declare const subagent: SubagentDiscoverySnapshot;
declare const subgraph: SubgraphDiscoverySnapshot;

// ============================================================================
// Type Tests: Messages are @langchain/core class instances
// ============================================================================

describe("useStream exposes BaseMessage class instances", () => {
  test("stream.messages is BaseMessage[], not plain Message[]", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
    expectTypeOf(stream.messages).not.toEqualTypeOf<Message[]>();
  });

  test("individual messages are BaseMessage instances", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg).toExtend<BaseMessage>();
  });

  test("values property exists", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream).toHaveProperty("values");
  });
});

// ============================================================================
// Type Tests: Class methods available on messages
// ============================================================================

describe("BaseMessage class methods are available", () => {
  test("toDict() returns StoredMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.toDict()).toEqualTypeOf<StoredMessage>();
  });

  test("getType() returns MessageType", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const msgType = msg.getType();
    expectTypeOf(msgType).toBeString();
  });

  test("toFormattedString() is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.toFormattedString()).toEqualTypeOf<string>();
  });

  test("text getter is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.text).toEqualTypeOf<string>();
  });

  test("contentBlocks getter is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.contentBlocks).toBeArray();
  });

  test("id property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.id).toEqualTypeOf<string | undefined>();
  });

  test("type property is available", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg).toHaveProperty("type");
  });
});

// ============================================================================
// Type Tests: Static type guards (isInstance)
// ============================================================================

describe("static type guard narrowing with isInstance", () => {
  test("AIMessage.isInstance() narrows to AIMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("narrowed AIMessage has tool_calls", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessage.isInstance(msg)) {
      expectTypeOf(msg).toHaveProperty("tool_calls");
      expectTypeOf(msg).toHaveProperty("invalid_tool_calls");
      expectTypeOf(msg).toHaveProperty("usage_metadata");
    }
  });

  test("AIMessageChunk.isInstance() narrows to AIMessageChunk", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (AIMessageChunk.isInstance(msg)) {
      expectTypeOf(msg).toExtend<AIMessageChunk>();
      expectTypeOf(msg.type).toEqualTypeOf<"ai">();
    }
  });

  test("HumanMessage.isInstance() narrows to HumanMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (HumanMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<HumanMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"human">();
    }
  });

  test("ToolMessage.isInstance() narrows to ToolMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (ToolMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<ToolMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"tool">();
      expectTypeOf(msg).toHaveProperty("tool_call_id");
    }
  });

  test("SystemMessage.isInstance() narrows to SystemMessage", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    if (SystemMessage.isInstance(msg)) {
      expectTypeOf(msg).toExtend<SystemMessage>();
      expectTypeOf(msg.type).toEqualTypeOf<"system">();
    }
  });
});

// ============================================================================
// Type Tests: Type discriminant narrowing
// ============================================================================

describe("type discriminant still works for narrowing", () => {
  test("msg.type is a string (MessageType)", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    expectTypeOf(msg.type).toBeString();
  });
});

// ============================================================================
// Type Tests: Custom state with class instance messages
// ============================================================================

describe("custom state types work with class instance messages", () => {
  test("values property exists with custom state", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream).toHaveProperty("values");
  });

  test("stream.messages is still BaseMessage[]", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
  });

  test("submit accepts custom state update", () => {
    const stream = useStream<CustomState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit).toBeCallableWith(
      { messages: [{ type: "human", content: "hello" }] },
      undefined,
    );
  });
});

// ============================================================================
// Type Tests: Core stream properties unaffected
// ============================================================================

describe("core stream properties are unaffected", () => {
  test("isLoading is boolean", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.isLoading).toEqualTypeOf<boolean>();
  });

  test("error is unknown", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.error).toEqualTypeOf<unknown>();
  });

  test("stop returns Promise<void>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
  });

  test("submit returns Promise<void>", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.submit(null)).toEqualTypeOf<Promise<void>>();
  });

  test("threadId is nullable string", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.threadId).toEqualTypeOf<string | null>();
  });

  test("assistantId is string", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.assistantId).toEqualTypeOf<string>();
  });
});

// ============================================================================
// Type Tests: useMessageMetadata works with BaseMessage ids
// ============================================================================

describe("useMessageMetadata accepts BaseMessage ids", () => {
  test("useMessageMetadata can be called with a class instance id", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const metadata = useMessageMetadata(stream, () => msg.id);

    if (metadata.current) {
      expectTypeOf(metadata.current.parentCheckpointId).toEqualTypeOf<
        string | undefined
      >();
    }
  });
});

// ============================================================================
// Type Tests: v1 selector composables and options
// ============================================================================

describe("selector composables mirror the v1 Svelte surface", () => {
  test("useMessages returns a Svelte current handle with BaseMessage[]", () => {
    expectTypeOf(useMessages(typedStream).current).toEqualTypeOf<
      BaseMessage[]
    >();
    expectTypeOf(useMessages(typedStream, subagent).current).toEqualTypeOf<
      BaseMessage[]
    >();
    expectTypeOf(useMessages(typedStream, subgraph).current).toEqualTypeOf<
      BaseMessage[]
    >();
  });

  test("useToolCalls returns assembled protocol tool calls", () => {
    expectTypeOf(useToolCalls(typedStream).current).toEqualTypeOf<
      AssembledToolCall[]
    >();
    expectTypeOf(useToolCalls(typedStream, subagent).current).toEqualTypeOf<
      AssembledToolCall[]
    >();
  });

  test("useValues infers root state and allows typed scoped values", () => {
    expectTypeOf(useValues(typedStream).current).toEqualTypeOf<BedtimeState>();
    expectTypeOf(useValues(typedStream, subagent).current).toEqualTypeOf<
      unknown
    >();
    expectTypeOf(
      useValues<SubagentValues>(typedStream, subagent).current,
    ).toEqualTypeOf<SubagentValues | undefined>();
    expectTypeOf(
      useValues<SubagentValues>(typedStream, { namespace: ["a", "b"] }).current,
    ).toEqualTypeOf<SubagentValues | undefined>();
  });

  test("extension and raw channel selectors expose current handles", () => {
    const channels: readonly Channel[] = ["custom", "messages"];
    expectTypeOf(
      useExtension<{ label: string }>(typedStream, "status").current,
    ).toEqualTypeOf<{ label: string } | undefined>();
    expectTypeOf(useExtension(typedStream, "status").current).toEqualTypeOf<
      unknown
    >();
    expectTypeOf(useChannel(typedStream, channels).current).toEqualTypeOf<
      Event[]
    >();
    expectTypeOf(
      useChannel(typedStream, ["custom"], subagent, { bufferSize: 50 }).current,
    ).toEqualTypeOf<Event[]>();
  });

  test("media selectors and media helpers expose typed handles", () => {
    expectTypeOf(useAudio(typedStream).current).toEqualTypeOf<AudioMedia[]>();
    expectTypeOf(useImages(typedStream).current).toEqualTypeOf<ImageMedia[]>();
    expectTypeOf(useVideo(typedStream).current).toEqualTypeOf<VideoMedia[]>();
    expectTypeOf(useFiles(typedStream).current).toEqualTypeOf<FileMedia[]>();

    const audio: AudioMedia | undefined = undefined;
    const video: VideoMedia | undefined = undefined;
    expectTypeOf(useMediaURL(audio).current).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf(useAudioPlayer(audio)).toEqualTypeOf<AudioPlayerHandle>();
    expectTypeOf(useVideoPlayer(null, video)).toEqualTypeOf<VideoPlayerHandle>();
    expectTypeOf(useAudioPlayer(undefined).status).toEqualTypeOf<PlayerStatus>();
  });

  test("SelectorTarget accepts every public target shape", () => {
    expectTypeOf<undefined>().toExtend<SelectorTarget>();
    expectTypeOf<null>().toExtend<SelectorTarget>();
    expectTypeOf<SubagentDiscoverySnapshot>().toExtend<SelectorTarget>();
    expectTypeOf<SubgraphDiscoverySnapshot>().toExtend<SelectorTarget>();
    expectTypeOf<{ readonly namespace: readonly string[] }>().toExtend<
      SelectorTarget
    >();
    expectTypeOf<readonly string[]>().toExtend<SelectorTarget>();
  });
});

describe("v1 useStream options and submit typing", () => {
  test("UseStreamOptions is the agent-server/custom-adapter union", () => {
    expectTypeOf<UseStreamOptions<BedtimeState>>().toEqualTypeOf<
      AgentServerOptions<BedtimeState> | CustomAdapterOptions<BedtimeState>
    >();
  });

  test("threadId accepts a getter for reactive Svelte thread switching", () => {
    expectTypeOf(useStream<BedtimeState>).toBeCallableWith({
      assistantId: "agent",
      threadId: () => "thread-1",
    });
    expectTypeOf(useStream<BedtimeState>).toBeCallableWith({
      assistantId: "agent",
      threadId: () => null,
    });
  });

  test("submit accepts BaseMessage instances and v1 options", () => {
    const widened: WidenUpdateMessages<Partial<BedtimeState>> = {
      messages: [new HumanMessage("hi")],
    };
    expectTypeOf(widened.messages).toMatchTypeOf<
      BaseMessage | BaseMessage[] | undefined
    >();
    expectTypeOf(typedStream.submit).toBeCallableWith({
      messages: new HumanMessage("hi"),
    });
    expectTypeOf(typedStream.submit).toBeCallableWith(null, {
      command: { resume: "approved" },
    });
    expectTypeOf(typedStream.submit).toBeCallableWith(
      { theme: "dark" },
      { multitaskStrategy: "enqueue" },
    );
  });
});

describe("v1 companion composables", () => {
  test("AnyStream accepts fully typed stream handles", () => {
    expectTypeOf<typeof typedStream>().toExtend<AnyStream>();
    expectTypeOf<UseStreamReturn<BedtimeState>>().toExtend<AnyStream>();
  });

  test("useSubmissionQueue exposes the Svelte queue companion shape", () => {
    const queue = useSubmissionQueue(typedStream);
    expectTypeOf(queue).toMatchTypeOf<
      UseSubmissionQueueReturn<BedtimeState>
    >();
    expectTypeOf(queue.entries).toEqualTypeOf<
      SubmissionQueueSnapshot<BedtimeState>
    >();
    expectTypeOf(queue.size).toBeNumber();
    expectTypeOf(queue.cancel).toEqualTypeOf<
      (id: string) => Promise<boolean>
    >();
    expectTypeOf(queue.clear).toEqualTypeOf<() => Promise<void>>();
  });

  test("useMessageMetadata returns MessageMetadata via current", () => {
    const meta = useMessageMetadata(typedStream, "m_0");
    expectTypeOf(meta.current).toEqualTypeOf<MessageMetadata | undefined>();
    expectTypeOf(useMessageMetadata).toBeCallableWith(typedStream, undefined);
  });
});

// ============================================================================
// Type Tests: Integration — realistic usage patterns
// ============================================================================

describe("realistic usage patterns with class instances", () => {
  test("iterating messages and rendering by type", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    for (const msg of stream.messages) {
      expectTypeOf(msg).toExtend<BaseMessage>();
      expectTypeOf(msg.content).not.toBeNever();

      if (AIMessage.isInstance(msg)) {
        expectTypeOf(msg.type).toEqualTypeOf<"ai">();
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const tc = msg.tool_calls[0];
          expectTypeOf(tc).toHaveProperty("name");
          expectTypeOf(tc).toHaveProperty("args");
        }
      }

      if (HumanMessage.isInstance(msg)) {
        expectTypeOf(msg.type).toEqualTypeOf<"human">();
      }
    }
  });

  test("converting back to plain dict for serialization", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const dict = msg.toDict();
    expectTypeOf(dict.type).toEqualTypeOf<string>();
    expectTypeOf(dict.data).toHaveProperty("content");
  });

  test("using text getter for simple content extraction", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const texts = stream.messages.map((m) => m.text);
    expectTypeOf(texts).toEqualTypeOf<string[]>();
  });

  test("using contentBlocks for rich content rendering", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const msg = stream.messages[0];
    const blocks = msg.contentBlocks;
    expectTypeOf(blocks).toBeArray();
  });

  test("filtering messages by type using class type guards", () => {
    const stream = useStream<BasicState>({
      assistantId: "agent",
    });

    const aiMessages = stream.messages.filter(AIMessage.isInstance);
    expectTypeOf(aiMessages).toExtend<AIMessage[]>();

    const humanMessages = stream.messages.filter(HumanMessage.isInstance);
    expectTypeOf(humanMessages).toExtend<HumanMessage[]>();

    const toolMessages = stream.messages.filter(ToolMessage.isInstance);
    expectTypeOf(toolMessages).toExtend<ToolMessage[]>();
  });
});

// ============================================================================
// Type Tests: provideStream / getStream
// ============================================================================

describe("provideStream / getStream types", () => {
  test("provideStream returns the provided stream handle", () => {
    const stream = provideStream<BasicState>({
      assistantId: "agent",
    });

    expectTypeOf(stream.messages).toExtend<BaseMessage[]>();
    expectTypeOf(stream.submit).toBeFunction();
  });

  test("getStream returns stream with BaseMessage[]", () => {
    const ctx = getStream<BasicState>();

    expectTypeOf(ctx.messages).toExtend<BaseMessage[]>();
    expectTypeOf(ctx.isLoading).toEqualTypeOf<boolean>();
    expectTypeOf(ctx.error).toEqualTypeOf<unknown>();
  });

  test("getStream messages is BaseMessage[]", () => {
    const ctx = getStream<BasicState>();

    expectTypeOf(ctx.messages).toExtend<BaseMessage[]>();
  });

  test("getStream with custom state type", () => {
    const ctx = getStream<CustomState>();

    expectTypeOf(ctx.messages).toExtend<BaseMessage[]>();
    expectTypeOf(ctx).toHaveProperty("values");
    expectTypeOf(ctx).toHaveProperty("submit");
    expectTypeOf(ctx).toHaveProperty("stop");
  });

  test("getStream has submit function", () => {
    const ctx = getStream<BasicState>();

    expectTypeOf(ctx.submit).toBeFunction();
  });

  test("getStream has stop function", () => {
    const ctx = getStream<BasicState>();

    expectTypeOf(ctx.stop).toBeFunction();
  });
});
