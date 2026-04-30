/**
 * Type tests for the v2-native stream hooks.
 *
 * These exercises the public type surface of
 * `libs/sdk-react/src/*` — the root hook
 * (`useStream`), the selector hooks (`useMessages`,
 * `useToolCalls`, `useValues`, `useExtension`, `useChannel`,
 * `useAudio`, `useImages`, `useVideo`, `useFiles`), and the media
 * player hooks (`useAudioPlayer`, `useVideoPlayer`,
 * `useMediaURL`).
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles
 * them via `tsconfig.typecheck.json` to verify type correctness.
 */

import { describe, expectTypeOf, test } from "vitest";
import { createRef } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Interrupt } from "@langchain/langgraph-sdk";
import type {
  AssembledToolCall,
  AudioMedia,
  Channel,
  Event,
  FileMedia,
  ImageMedia,
  InferStateType,
  InferSubagentStates,
  InferToolCalls,
  MessageMetadata,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  SubmissionQueueSnapshot,
  VideoMedia,
  WidenUpdateMessages,
} from "@langchain/langgraph-sdk/stream";

import {
  useStream,
  useMessageMetadata,
  useMessages,
  useSubmissionQueue,
  useToolCalls,
  useValues,
  useExtension,
  useChannel,
  useAudio,
  useImages,
  useVideo,
  useFiles,
  useMediaURL,
  useAudioPlayer,
  useVideoPlayer,
  type AgentServerOptions,
  type AnyStream,
  type AudioPlayerHandle,
  type CustomAdapterOptions,
  type PlayerStatus,
  type SelectorTarget,
  type UseStreamOptions,
  type UseStreamReturn,
  type UseSubmissionQueueReturn,
  type VideoPlayerHandle,
} from "../index.js";

// ============================================================================
// Test state / interrupt shapes
// ============================================================================

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

// Shared handles used across tests. Kept at module scope so we don't
// re-instantiate the hook (which Vitest's typecheck compiler flags as
// a side effect).
declare const stream: UseStreamReturn<
  BedtimeState,
  ApprovalRequest,
  TenantConfig
>;

declare const subagent: SubagentDiscoverySnapshot;
declare const subgraph: SubgraphDiscoverySnapshot;

// ============================================================================
// Root hook — `useStream` generic propagation
// ============================================================================

describe("useStream — return type", () => {
  test("defaults: values is Record<string, unknown>, interrupt is unknown", () => {
    const s = useStream({ assistantId: "agent" });

    expectTypeOf(s.values).toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf(s.interrupt).toEqualTypeOf<Interrupt<unknown> | undefined>();
    expectTypeOf(s.interrupts).toEqualTypeOf<Interrupt<unknown>[]>();
  });

  test("explicit StateType flows into `values` (non-nullable at the root)", () => {
    const s = useStream<BedtimeState>({ assistantId: "agent" });

    expectTypeOf(s.values).toEqualTypeOf<BedtimeState>();
    // The root snapshot always carries values — never `undefined`.
    expectTypeOf(s.values).not.toEqualTypeOf<BedtimeState | undefined>();
  });

  test("explicit InterruptType flows into `interrupt` / `interrupts`", () => {
    const s = useStream<BedtimeState, ApprovalRequest>({
      assistantId: "agent",
    });

    expectTypeOf(s.interrupt).toEqualTypeOf<
      Interrupt<ApprovalRequest> | undefined
    >();
    expectTypeOf(s.interrupts).toEqualTypeOf<Interrupt<ApprovalRequest>[]>();
  });

  test("messages is always BaseMessage[] regardless of StateType", () => {
    const s = useStream<BedtimeState>({ assistantId: "agent" });
    expectTypeOf(s.messages).toEqualTypeOf<BaseMessage[]>();
  });

  test("compiled graph type unwraps to its state shape", async () => {
    // A real compiled graph — `typeof agent` carries the `"~RunOutput"`
    // brand inherited from `CompiledGraph`, which `InferStateType<T>` mines
    // to recover the state type.
    const { MessagesAnnotation, StateGraph } = await import(
      "@langchain/langgraph"
    );
    const agent = new StateGraph(MessagesAnnotation).compile();

    const s = useStream<typeof agent>({ assistantId: "agent" });

    // `values` is the graph's state, *not* the `CompiledStateGraph` class.
    expectTypeOf(s.values).toEqualTypeOf<{ messages: BaseMessage[] }>();
    expectTypeOf(s.values).not.toEqualTypeOf<typeof agent>();
  });


  test("discovery maps have the right shapes", () => {
    expectTypeOf(stream.subagents).toEqualTypeOf<
      ReadonlyMap<string, SubagentDiscoverySnapshot>
    >();
    expectTypeOf(stream.subgraphs).toEqualTypeOf<
      ReadonlyMap<string, SubgraphDiscoverySnapshot>
    >();
    expectTypeOf(stream.subgraphsByNode).toEqualTypeOf<
      ReadonlyMap<string, readonly SubgraphDiscoverySnapshot[]>
    >();
  });

  test("root status fields", () => {
    expectTypeOf(stream.isLoading).toBeBoolean();
    expectTypeOf(stream.isThreadLoading).toBeBoolean();
    expectTypeOf(stream.error).toBeUnknown();
    expectTypeOf(stream.threadId).toEqualTypeOf<string | null>();
  });
});

// ============================================================================
// `submit` — `input` is typed against `StateType`
// ============================================================================

describe("useStream — submit() input typing", () => {
  test("accepts Partial<StateType>", () => {
    // Every field optional — the whole point of Partial.
    expectTypeOf(stream.submit).toBeCallableWith({
      messages: [] as BaseMessage[],
    });
    expectTypeOf(stream.submit).toBeCallableWith({ paragraphs: ["once…"] });
    expectTypeOf(stream.submit).toBeCallableWith({ theme: "dark" });
    expectTypeOf(stream.submit).toBeCallableWith({});
  });

  test("accepts null and undefined (resume path)", () => {
    expectTypeOf(stream.submit).toBeCallableWith(null);
    expectTypeOf(stream.submit).toBeCallableWith(undefined);
  });

  test("options are typed against StateType + ConfigurableType", () => {
    expectTypeOf(stream.submit).toBeCallableWith(null, {
      command: { resume: { approved: true } },
    });
    expectTypeOf(stream.submit).toBeCallableWith(
      { paragraphs: ["…"] },
      {
        config: {
          configurable: { tenantId: "acme", region: "us" },
        },
      }
    );
  });

  test("submit returns Promise<void>", () => {
    expectTypeOf(stream.submit({})).toEqualTypeOf<Promise<void>>();
  });

  test("StreamSubmitOptions carries the configured state / config generics", () => {
    expectTypeOf<
      Parameters<typeof stream.submit>[1]
    >().toEqualTypeOf<
      StreamSubmitOptions<BedtimeState, TenantConfig> | undefined
    >();
  });

  test("respond / stop keep their signatures", () => {
    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.respond).toBeCallableWith({ approved: true });
    expectTypeOf(stream.respond).toBeCallableWith(
      { approved: true },
      { interruptId: "i_0" }
    );
    expectTypeOf(stream.respond).toBeCallableWith(
      { approved: true },
      { interruptId: "i_0", namespace: ["researcher:abc"] }
    );
  });
});

// ============================================================================
// `useMessages` / `useToolCalls` — namespace-polymorphic, state-agnostic
// ============================================================================

describe("useMessages — target polymorphism", () => {
  test("always returns BaseMessage[]", () => {
    expectTypeOf(useMessages(stream)).toEqualTypeOf<BaseMessage[]>();
    expectTypeOf(useMessages(stream, subagent)).toEqualTypeOf<BaseMessage[]>();
    expectTypeOf(useMessages(stream, subgraph)).toEqualTypeOf<BaseMessage[]>();
  });

  test("accepts { namespace: string[] } literals", () => {
    expectTypeOf(
      useMessages(stream, { namespace: ["researcher:abc"] })
    ).toEqualTypeOf<BaseMessage[]>();
  });

  test("accepts raw readonly string[]", () => {
    const ns = ["researcher:abc"] as const;
    expectTypeOf(useMessages(stream, ns)).toEqualTypeOf<BaseMessage[]>();
  });

  test("accepts explicit undefined / null targets (root)", () => {
    expectTypeOf(useMessages(stream, undefined)).toEqualTypeOf<BaseMessage[]>();
    expectTypeOf(useMessages(stream, null)).toEqualTypeOf<BaseMessage[]>();
  });
});

describe("useToolCalls — target polymorphism", () => {
  test("always returns AssembledToolCall[]", () => {
    expectTypeOf(useToolCalls(stream)).toEqualTypeOf<AssembledToolCall[]>();
    expectTypeOf(useToolCalls(stream, subagent)).toEqualTypeOf<
      AssembledToolCall[]
    >();
    expectTypeOf(useToolCalls(stream, subgraph)).toEqualTypeOf<
      AssembledToolCall[]
    >();
  });
});

// ============================================================================
// `useValues` — state inference (this is the #2 fix under test)
// ============================================================================

describe("useValues — root form infers StateType from the stream", () => {
  test("`useValues(stream)` returns StateType (no explicit generic)", () => {
    // The crucial DevX guarantee: no re-annotation required at the
    // call site — the state shape flows from the root hook.
    const values = useValues(stream);
    expectTypeOf(values).toEqualTypeOf<BedtimeState>();
  });

  test("root form is non-nullable (values always populated)", () => {
    const values = useValues(stream);
    expectTypeOf(values).not.toEqualTypeOf<BedtimeState | undefined>();
  });

  test("root form with a default-generic stream falls back to Record<string, unknown>", () => {
    const s = useStream({ assistantId: "agent" });
    expectTypeOf(useValues(s)).toEqualTypeOf<Record<string, unknown>>();
  });
});

describe("useValues — scoped form takes an explicit shape", () => {
  test("`useValues(stream, target)` without generic is unknown | undefined", () => {
    const values = useValues(stream, subagent);
    expectTypeOf(values).toEqualTypeOf<unknown>();
  });

  test("`useValues<Shape>(stream, target)` returns Shape | undefined", () => {
    const values = useValues<SubagentValues>(stream, subagent);
    expectTypeOf(values).toEqualTypeOf<SubagentValues | undefined>();
  });

  test("scoped form honours messagesKey option", () => {
    const values = useValues<SubagentValues>(stream, subagent, {
      messagesKey: "chat",
    });
    expectTypeOf(values).toEqualTypeOf<SubagentValues | undefined>();
  });

  test("scoped form accepts subgraph / namespace / string[] targets", () => {
    expectTypeOf(useValues<SubagentValues>(stream, subgraph)).toEqualTypeOf<
      SubagentValues | undefined
    >();
    expectTypeOf(
      useValues<SubagentValues>(stream, { namespace: ["a", "b"] })
    ).toEqualTypeOf<SubagentValues | undefined>();
    expectTypeOf(
      useValues<SubagentValues>(stream, ["a", "b"] as const)
    ).toEqualTypeOf<SubagentValues | undefined>();
  });
});

// ============================================================================
// `useExtension` — user-typed payload
// ============================================================================

describe("useExtension — T is explicit, target is optional", () => {
  test("returns T | undefined at the root", () => {
    const ext = useExtension<{ label: string }>(stream, "status");
    expectTypeOf(ext).toEqualTypeOf<{ label: string } | undefined>();
  });

  test("returns T | undefined scoped to a target", () => {
    const ext = useExtension<{ label: string }>(stream, "status", subagent);
    expectTypeOf(ext).toEqualTypeOf<{ label: string } | undefined>();
  });

  test("default T is unknown", () => {
    const ext = useExtension(stream, "status");
    expectTypeOf(ext).toEqualTypeOf<unknown>();
  });
});

// ============================================================================
// `useChannel` — raw event escape hatch
// ============================================================================

describe("useChannel — raw events", () => {
  test("returns Event[] with typed channel list", () => {
    const channels: readonly Channel[] = ["custom", "messages"];
    const events = useChannel(stream, channels);
    expectTypeOf(events).toEqualTypeOf<Event[]>();
  });

  test("accepts a target and bufferSize option", () => {
    const events = useChannel(stream, ["custom"], subagent, { bufferSize: 50 });
    expectTypeOf(events).toEqualTypeOf<Event[]>();
  });
});

// ============================================================================
// Media selectors — one hook per kind, typed handles
// ============================================================================

describe("useAudio / useImages / useVideo / useFiles return kind-typed handles", () => {
  test("useAudio returns AudioMedia[]", () => {
    expectTypeOf(useAudio(stream)).toEqualTypeOf<AudioMedia[]>();
    expectTypeOf(useAudio(stream, subagent)).toEqualTypeOf<AudioMedia[]>();
  });

  test("useImages returns ImageMedia[]", () => {
    expectTypeOf(useImages(stream)).toEqualTypeOf<ImageMedia[]>();
    expectTypeOf(useImages(stream, subgraph)).toEqualTypeOf<ImageMedia[]>();
  });

  test("useVideo returns VideoMedia[]", () => {
    expectTypeOf(useVideo(stream)).toEqualTypeOf<VideoMedia[]>();
  });

  test("useFiles returns FileMedia[]", () => {
    expectTypeOf(useFiles(stream)).toEqualTypeOf<FileMedia[]>();
  });
});

// ============================================================================
// `useMediaURL` — narrow bridge to native elements
// ============================================================================

describe("useMediaURL — returns string | undefined", () => {
  test("accepts any media handle union", () => {
    const audio: AudioMedia | undefined = undefined;
    const image: ImageMedia | undefined = undefined;
    const video: VideoMedia | undefined = undefined;
    const file: FileMedia | undefined = undefined;

    expectTypeOf(useMediaURL(audio)).toEqualTypeOf<string | undefined>();
    expectTypeOf(useMediaURL(image)).toEqualTypeOf<string | undefined>();
    expectTypeOf(useMediaURL(video)).toEqualTypeOf<string | undefined>();
    expectTypeOf(useMediaURL(file)).toEqualTypeOf<string | undefined>();
  });
});

// ============================================================================
// `useAudioPlayer` / `useVideoPlayer` — playback handles
// ============================================================================

describe("useAudioPlayer — handle shape", () => {
  test("returns AudioPlayerHandle for a handle or undefined", () => {
    const clip: AudioMedia | undefined = undefined;
    const handle = useAudioPlayer(clip);
    expectTypeOf(handle).toEqualTypeOf<AudioPlayerHandle>();
  });

  test("status is the unified PlayerStatus enum", () => {
    const handle = useAudioPlayer(undefined);
    expectTypeOf(handle.status).toEqualTypeOf<PlayerStatus>();
    expectTypeOf<PlayerStatus>().toEqualTypeOf<
      "idle" | "buffering" | "playing" | "paused" | "finished" | "error"
    >();
  });

  test("core controls are present and return void", () => {
    const handle = useAudioPlayer(undefined);
    expectTypeOf(handle.play).toEqualTypeOf<() => void>();
    expectTypeOf(handle.pause).toEqualTypeOf<() => void>();
    expectTypeOf(handle.stop).toEqualTypeOf<() => void>();
    expectTypeOf(handle.toggle).toEqualTypeOf<() => void>();
    expectTypeOf(handle.reset).toEqualTypeOf<() => void>();
  });

  test("playToEnd returns Promise<void>", () => {
    const handle = useAudioPlayer(undefined);
    expectTypeOf(handle.playToEnd()).toEqualTypeOf<Promise<void>>();
  });

  test("visualization taps are present", () => {
    const handle = useAudioPlayer(undefined);
    expectTypeOf(handle.level).toBeNumber();
    expectTypeOf(handle.getFrequencyData).toEqualTypeOf<
      () => Uint8Array | undefined
    >();
    expectTypeOf(handle.getTimeDomainData).toEqualTypeOf<
      () => Uint8Array | undefined
    >();
  });

  test("strategy-dependent fields are optional", () => {
    const handle = useAudioPlayer(undefined);
    expectTypeOf(handle.duration).toEqualTypeOf<number | undefined>();
    expectTypeOf(handle.seek).toEqualTypeOf<
      ((seconds: number) => void) | undefined
    >();
    expectTypeOf(handle.strategy).toEqualTypeOf<"pcm" | "element">();
  });

  test("accepts option overrides", () => {
    expectTypeOf(useAudioPlayer).toBeCallableWith(undefined, {
      autoPlay: true,
      pcm: { sampleRate: 24000, channels: 1 },
      pcmMimePrefixes: ["audio/pcm16"],
      strategy: "pcm",
    });
  });
});

describe("useVideoPlayer — handle shape", () => {
  test("requires a RefObject and returns VideoPlayerHandle", () => {
    const videoRef = createRef<HTMLVideoElement>();
    const clip: VideoMedia | undefined = undefined;
    const handle = useVideoPlayer(videoRef, clip);
    expectTypeOf(handle).toEqualTypeOf<VideoPlayerHandle>();
  });

  test("video playback handle has seek as non-optional", () => {
    const videoRef = createRef<HTMLVideoElement>();
    const handle = useVideoPlayer(videoRef, undefined);
    expectTypeOf(handle.seek).toEqualTypeOf<(seconds: number) => void>();
    expectTypeOf(handle.status).toEqualTypeOf<PlayerStatus>();
  });

  test("accepts autoPlay option", () => {
    const videoRef = createRef<HTMLVideoElement>();
    expectTypeOf(useVideoPlayer).toBeCallableWith(videoRef, undefined, {
      autoPlay: true,
    });
  });
});

// ============================================================================
// `SelectorTarget` — union coverage
// ============================================================================

describe("SelectorTarget — every accepted shape", () => {
  test("accepts undefined / null (root)", () => {
    expectTypeOf<undefined>().toExtend<SelectorTarget>();
    expectTypeOf<null>().toExtend<SelectorTarget>();
  });

  test("accepts SubagentDiscoverySnapshot / SubgraphDiscoverySnapshot", () => {
    expectTypeOf<SubagentDiscoverySnapshot>().toExtend<SelectorTarget>();
    expectTypeOf<SubgraphDiscoverySnapshot>().toExtend<SelectorTarget>();
  });

  test("accepts { namespace } literal and readonly string[]", () => {
    expectTypeOf<{
      readonly namespace: readonly string[];
    }>().toExtend<SelectorTarget>();
    expectTypeOf<readonly string[]>().toExtend<SelectorTarget>();
  });
});

// ============================================================================
// Backwards-compatibility — the explicit-generic call style still works
// ============================================================================

describe("back-compat — explicit generics on selectors", () => {
  test("`useValues<T>(stream)` still compiles when T matches the stream state", () => {
    // Legacy call shape from `tests/components/ExtensionSelectorsStream.tsx`.
    const values = useValues<BedtimeState>(stream);
    expectTypeOf(values).toEqualTypeOf<BedtimeState>();
  });

  test("stream handle is assignable with the three-generic form intact", () => {
    expectTypeOf<typeof stream>().toEqualTypeOf<
      UseStreamReturn<BedtimeState, ApprovalRequest, TenantConfig>
    >();
  });

  test("AnyStream accepts any fully-typed stream handle", () => {
    // The whole point of `AnyStream`: a wrapper component that only
    // forwards the handle to selector hooks doesn't want to repeat the
    // caller's state/interrupt/configurable types. Any concrete
    // `UseStreamReturn<S, I, C>` should be assignable.
    expectTypeOf<typeof stream>().toExtend<AnyStream>();
    expectTypeOf<
      UseStreamReturn<BedtimeState>
    >().toExtend<AnyStream>();
    expectTypeOf<
      UseStreamReturn<Record<string, unknown>>
    >().toExtend<AnyStream>();
  });
});

// ============================================================================
// `InferStateType` / `InferToolCalls` / `InferSubagentStates` — the public
// type-inference helpers callers reach for when prop-drilling a stream
// handle across components.
// ============================================================================

describe("InferStateType — unwraps agent brands, compiled graphs, plain types", () => {
  test("plain records pass through unchanged", () => {
    type R = { foo: string; bar: number } & Record<string, unknown>;
    expectTypeOf<InferStateType<R>>().toEqualTypeOf<R>();
  });

  test("compiled graph types unwrap to their state shape", async () => {
    const { MessagesAnnotation, StateGraph } = await import(
      "@langchain/langgraph"
    );
    const agent = new StateGraph(MessagesAnnotation).compile();
    expectTypeOf<InferStateType<typeof agent>>().toEqualTypeOf<{
      messages: BaseMessage[];
    }>();
  });

  test("defaults fall back to Record<string, unknown>", () => {
    expectTypeOf<InferStateType<unknown>>().toEqualTypeOf<
      Record<string, unknown>
    >();
  });
});

describe("InferToolCalls — unwraps arrays of tools, agent brands, direct shapes", () => {
  test("array of tools produces a discriminated union", async () => {
    const { tool } = await import("langchain");
    const { z } = await import("zod/v4");
    const searchTool = tool(async () => "ok", {
      name: "search",
      description: "s",
      schema: z.object({ query: z.string() }),
    });
    const lookupTool = tool(async () => "ok", {
      name: "lookup",
      description: "l",
      schema: z.object({ id: z.string() }),
    });
    type Calls = InferToolCalls<
      readonly [typeof searchTool, typeof lookupTool]
    >;
    // Union should distinguish by `name` / `args`.
    expectTypeOf<Calls>().not.toBeNever();
    expectTypeOf<Calls["name"]>().toEqualTypeOf<"search" | "lookup">();
  });

  test("non-agent / non-array inputs fall back to DefaultToolCall", () => {
    // `InferToolCalls` only narrows when given an agent brand or a
    // readonly tool array; any other shape defers to the default
    // untyped tool-call surface (see types-inference.ts).
    expectTypeOf<InferToolCalls<BedtimeState>>().not.toBeNever();
  });
});

describe("InferSubagentStates — DeepAgent maps", () => {
  test("non-DeepAgent inputs fall back to the default map", () => {
    type Map = InferSubagentStates<BedtimeState>;
    // `BedtimeState` isn't a DeepAgent brand — the helper falls back
    // to the default (untyped) subagent state map.
    expectTypeOf<Map>().not.toBeNever();
  });
});

// ============================================================================
// `WidenUpdateMessages` — submit() accepts BaseMessage instances OR wire shapes
// ============================================================================

describe("WidenUpdateMessages — submit() input widening", () => {
  test("BaseMessage instances typecheck against widened messages[]", () => {
    const widened: WidenUpdateMessages<Partial<BedtimeState>> = {
      messages: [new HumanMessage("hi")],
    };
    // The widened field accepts either a single BaseMessage, an array
    // of BaseMessage, or the original messages shape.
    expectTypeOf(widened.messages).toMatchTypeOf<
      BaseMessage | BaseMessage[] | undefined
    >();
  });

  test("stream.submit({ messages: [new HumanMessage(...)] }) typechecks", () => {
    expectTypeOf(stream.submit).toBeCallableWith({
      messages: [new HumanMessage("hi")],
    });
  });

  test("stream.submit accepts single BaseMessage (coerced to array)", () => {
    expectTypeOf(stream.submit).toBeCallableWith({
      messages: new HumanMessage("hi"),
    });
  });
});

// ============================================================================
// `submit()` options — command widening + forkFrom + multitaskStrategy
// ============================================================================

describe("submit() options — v1 widening", () => {
  test("command.resume / goto / update all typecheck", () => {
    expectTypeOf(stream.submit).toBeCallableWith(null, {
      command: { resume: "approved" },
    });
    expectTypeOf(stream.submit).toBeCallableWith(null, {
      command: { goto: "agent" },
    });
    expectTypeOf(stream.submit).toBeCallableWith(null, {
      command: { goto: { node: "agent", input: { foo: 1 } } },
    });
    expectTypeOf(stream.submit).toBeCallableWith(null, {
      command: { update: { paragraphs: ["…"] } },
    });
  });

  test("forkFrom checkpointId typechecks", () => {
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { forkFrom: { checkpointId: "cp_1" } }
    );
  });

  test("multitaskStrategy accepts every documented value", () => {
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { multitaskStrategy: "rollback" }
    );
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { multitaskStrategy: "interrupt" }
    );
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { multitaskStrategy: "enqueue" }
    );
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { multitaskStrategy: "reject" }
    );
  });
});

// ============================================================================
// Discriminated-union options — AgentServerOptions XOR CustomAdapterOptions
// ============================================================================

describe("UseStreamOptions — discriminated union", () => {
  test("assistantId alone compiles (LGP branch)", () => {
    expectTypeOf<{
      assistantId: string;
    }>().toExtend<AgentServerOptions<BedtimeState>>();
  });

  test("transport-as-adapter compiles (custom-adapter branch)", () => {
    type CustomOnly = Pick<CustomAdapterOptions<BedtimeState>, "transport">;
    expectTypeOf<CustomOnly>().toExtend<CustomAdapterOptions<BedtimeState>>();
  });

  test("options union is the sum of the two branches", () => {
    expectTypeOf<
      UseStreamOptions<BedtimeState>
    >().toEqualTypeOf<
      | AgentServerOptions<BedtimeState>
      | CustomAdapterOptions<BedtimeState>
    >();
  });
});

// ============================================================================
// `useSubmissionQueue` / `useMessageMetadata` companion hooks
// ============================================================================

describe("useSubmissionQueue — companion hook surface", () => {
  test("returns a UseSubmissionQueueReturn<BedtimeState> with entries / size / cancel / clear", () => {
    const q = useSubmissionQueue(stream);
    expectTypeOf(q).toMatchTypeOf<UseSubmissionQueueReturn<BedtimeState>>();
    expectTypeOf(q.entries).toEqualTypeOf<SubmissionQueueSnapshot<BedtimeState>>();
    expectTypeOf(q.size).toBeNumber();
    expectTypeOf(q.cancel).toEqualTypeOf<
      (id: string) => Promise<boolean>
    >();
    expectTypeOf(q.clear).toEqualTypeOf<() => Promise<void>>();
  });

  test("untyped form returns UseSubmissionQueueReturn with default state", () => {
    const untyped: AnyStream = stream;
    const q = useSubmissionQueue(untyped);
    expectTypeOf(q).toMatchTypeOf<UseSubmissionQueueReturn>();
  });
});

describe("useMessageMetadata — companion hook surface", () => {
  test("returns MessageMetadata | undefined for a message id", () => {
    const meta = useMessageMetadata(stream, "m_0");
    expectTypeOf(meta).toEqualTypeOf<MessageMetadata | undefined>();
  });

  test("accepts undefined messageId (treated as 'none')", () => {
    expectTypeOf(useMessageMetadata).toBeCallableWith(stream, undefined);
  });
});
