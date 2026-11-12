/**
 * Type tests for the stream hooks: the root hook (`useStream`) and the
 * selector hooks (`useMessages`, `useToolCalls`, `useValues`,
 * `useChannel`).
 *
 * NOTE: These tests are NOT executed at runtime. Vitest only compiles
 * them via `tsconfig.typecheck.json` to verify type correctness.
 */

import { describe, expectTypeOf, test } from "vitest";
import { tool } from "langchain";
import { z } from "zod/v4";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Interrupt } from "@langchain/langgraph-sdk";
import {
  useStream,
  useMessageMetadata,
  useMessages,
  useSubmissionQueue,
  useToolCalls,
  useValues,
  useChannel,
  type AgentServerOptions,
  type AnyStream,
  type AssembledToolCall,
  type Channel,
  type Event,
  type InferStateType,
  type InferSubagentStates,
  type InferToolCalls,
  type InferToolOutput,
  type MessageMetadata,
  type SelectorTarget,
  type StreamSubmitOptions,
  type SubagentDiscoverySnapshot,
  type SubgraphDiscoverySnapshot,
  type SubmissionQueueSnapshot,
  type ToolCallFromTool,
  type UseStreamOptions,
  type UseStreamReturn,
  type UseSubmissionQueueReturn,
  type WidenUpdateMessages,
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

  test("respond / stop / disconnect keep their signatures", () => {
    expectTypeOf(stream.stop()).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.stop({ cancel: false })).toEqualTypeOf<Promise<void>>();
    expectTypeOf(stream.disconnect()).toEqualTypeOf<Promise<void>>();
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
    // Legacy call shape from `tests/components/CustomChannelStream.tsx`.
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

describe("InferToolCalls — typed streaming tool handles", () => {
  test("array of tools produces a discriminated AssembledToolCall union", async () => {
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
    expectTypeOf<Calls["name"]>().toEqualTypeOf<"search" | "lookup">();

    type SearchCall = Extract<Calls, { name: "search" }>;
    expectTypeOf<SearchCall["input"]>().toMatchTypeOf<
      { query: string } | { id: string }
    >();
    expectTypeOf<SearchCall["status"]>().toEqualTypeOf<
      "running" | "finished" | "error"
    >();

    type LookupCall = Extract<Calls, { name: "lookup" }>;
    expectTypeOf<LookupCall["input"]>().toMatchTypeOf<
      { id: string } | { query: string }
    >();
  });

  test("non-agent inputs fall back to untyped AssembledToolCall", () => {
    expectTypeOf<InferToolCalls<BedtimeState>>().toExtend<AssembledToolCall>();
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

describe("InferToolCalls — agent brands and ToolCallFromTool alignment", () => {
  test("array of tools infers output types", async () => {
    const searchTool = tool(
      async ({ query }: { query: string }) => [`result:${query}`],
      {
        name: "search",
        description: "s",
        schema: z.object({ query: z.string() }),
      }
    );
    const lookupTool = tool(
      async ({ id }: { id: string }) => `found:${id}`,
      {
        name: "lookup",
        description: "l",
        schema: z.object({ id: z.string() }),
      }
    );
    type Calls = InferToolCalls<
      readonly [typeof searchTool, typeof lookupTool]
    >;
    expectTypeOf<InferToolOutput<typeof searchTool>>().toEqualTypeOf<string[]>();
    expectTypeOf<InferToolOutput<typeof lookupTool>>().toEqualTypeOf<string>();
    expectTypeOf<Calls>().toExtend<AssembledToolCall>();
  });

  test("InferToolCalls aligns with ToolCallFromTool args", async () => {
    const weatherTool = tool(
      async ({ location }: { location: string }) => `Weather in ${location}`,
      {
        name: "get_weather",
        description: "weather",
        schema: z.object({ location: z.string() }),
      }
    );

    type WeatherToolCall = ToolCallFromTool<typeof weatherTool>;
    type WeatherStreamCall = InferToolCalls<readonly [typeof weatherTool]>;

    expectTypeOf<WeatherStreamCall["name"]>().toEqualTypeOf<"get_weather">();
    expectTypeOf<WeatherStreamCall["args"]>().toEqualTypeOf<
      WeatherToolCall["args"]
    >();
  });

  test("InferToolCalls narrows input and output on agent brands", async () => {
    const weatherTool = tool(
      async ({ location }: { location: string }) => `Weather in ${location}`,
      {
        name: "get_weather",
        description: "weather",
        schema: z.object({ location: z.string() }),
      }
    );
    type Call = InferToolCalls<readonly [typeof weatherTool]>;
    expectTypeOf<Call["name"]>().toEqualTypeOf<"get_weather">();
    expectTypeOf<Call["input"]>().toEqualTypeOf<{ location: string }>();
    expectTypeOf<Call["args"]>().toEqualTypeOf<{ location: string }>();
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
  test("forkFrom checkpointId typechecks", () => {
    expectTypeOf(stream.submit).toBeCallableWith(
      { theme: "dark" },
      { forkFrom: "cp_1" }
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
// Options — the Agent Server's
// ============================================================================

describe("UseStreamOptions — the Agent Server's options", () => {
  test("assistantId alone compiles", () => {
    expectTypeOf<{
      assistantId: string;
    }>().toExtend<AgentServerOptions<BedtimeState>>();
  });

  test("options are AgentServerOptions", () => {
    expectTypeOf<UseStreamOptions<BedtimeState>>().toEqualTypeOf<
      AgentServerOptions<BedtimeState>
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
