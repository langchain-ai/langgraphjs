/**
 * Type tests for the experimental v2-native stream hooks.
 *
 * These exercises the public type surface of
 * `libs/sdk-react/src/stream-experimental/*` — the root hook
 * (`useStreamExperimental`), the selector hooks (`useMessages`,
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
import type { BaseMessage } from "@langchain/core/messages";
import type { Interrupt } from "@langchain/langgraph-sdk";
import type {
  AssembledToolCall,
  AudioMedia,
  Channel,
  Event,
  FileMedia,
  ImageMedia,
  StreamSubmitOptions,
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
  VideoMedia,
} from "@langchain/langgraph-sdk/stream";

import {
  useStreamExperimental,
  useMessages,
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
  type AudioPlayerHandle,
  type PlayerStatus,
  type SelectorTarget,
  type UseStreamExperimentalReturn,
  type VideoPlayerHandle,
} from "../../index.js";

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
declare const stream: UseStreamExperimentalReturn<
  BedtimeState,
  ApprovalRequest,
  TenantConfig
>;

declare const subagent: SubagentDiscoverySnapshot;
declare const subgraph: SubgraphDiscoverySnapshot;

// ============================================================================
// Root hook — `useStreamExperimental` generic propagation
// ============================================================================

describe("useStreamExperimental — return type", () => {
  test("defaults: values is Record<string, unknown>, interrupt is unknown", () => {
    const s = useStreamExperimental({ assistantId: "agent" });

    expectTypeOf(s.values).toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf(s.interrupt).toEqualTypeOf<Interrupt<unknown> | undefined>();
    expectTypeOf(s.interrupts).toEqualTypeOf<Interrupt<unknown>[]>();
  });

  test("explicit StateType flows into `values` (non-nullable at the root)", () => {
    const s = useStreamExperimental<BedtimeState>({ assistantId: "agent" });

    expectTypeOf(s.values).toEqualTypeOf<BedtimeState>();
    // The root snapshot always carries values — never `undefined`.
    expectTypeOf(s.values).not.toEqualTypeOf<BedtimeState | undefined>();
  });

  test("explicit InterruptType flows into `interrupt` / `interrupts`", () => {
    const s = useStreamExperimental<BedtimeState, ApprovalRequest>({
      assistantId: "agent",
    });

    expectTypeOf(s.interrupt).toEqualTypeOf<
      Interrupt<ApprovalRequest> | undefined
    >();
    expectTypeOf(s.interrupts).toEqualTypeOf<Interrupt<ApprovalRequest>[]>();
  });

  test("messages is always BaseMessage[] regardless of StateType", () => {
    const s = useStreamExperimental<BedtimeState>({ assistantId: "agent" });
    expectTypeOf(s.messages).toEqualTypeOf<BaseMessage[]>();
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

describe("useStreamExperimental — submit() input typing", () => {
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
    const s = useStreamExperimental({ assistantId: "agent" });
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
      UseStreamExperimentalReturn<BedtimeState, ApprovalRequest, TenantConfig>
    >();
  });
});
