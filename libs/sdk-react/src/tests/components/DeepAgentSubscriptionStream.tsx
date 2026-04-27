import { useEffect, useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type { SubagentDiscoverySnapshot } from "@langchain/langgraph-sdk/stream";

import {
  useStream,
  useMessages,
  useToolCalls,
  STREAM_CONTROLLER,
} from "../../index.js";

type Thread = ReturnType<
  typeof useStream<{ messages: BaseMessage[] }>
>;

interface InitialMounts {
  rootMessages?: boolean;
  researcherMessagesA?: boolean;
  researcherMessagesB?: boolean;
  researcherToolCalls?: boolean;
  analystMessages?: boolean;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  /**
   * Pre-flipped observer toggles. Mount-state-dependent observers
   * gate on the corresponding subagent being discovered, so setting
   * these to `true` causes the observer to attach *as soon as* the
   * subagent appears in `stream.subagents`. Tests use this to ensure
   * scoped projections subscribe early enough to capture the
   * subagent's events during the run.
   */
  initialMounts?: InitialMounts;
}

/**
 * Exercises the ref-counted subscription contract of the experimental
 * stream. The goal is to prove that scoped selector hooks (`useMessages`,
 * `useToolCalls`, …) only open server subscriptions for namespaces that
 * are *actually observed* by a mounted component, and that identical
 * acquisitions are deduped through `ChannelRegistry.acquire`.
 *
 * The component exposes:
 *  - `registry-size`              : number of live registry entries.
 *  - `registry-size-*`            : re-rendered on every state tick.
 *  - toggle buttons to mount / unmount each observer independently.
 *  - per-observer message / tool-call counts so tests can verify data
 *    isolation between subagents.
 *
 * Root-namespace reads (`useMessages(stream)` without a target) are
 * served by `stream.messages` directly and *never* open a registry
 * entry — the tests assert on that invariant.
 */
export function DeepAgentSubscriptionStream({
  apiUrl,
  assistantId = "deep_agent",
  initialMounts = {},
}: Props) {
  const thread = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
  });

  const subagents = [...thread.subagents.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const researcher = subagents.find((s) => s.name === "researcher");
  const analyst = subagents.find((s) => s.name === "data-analyst");

  const [mounts, setMounts] = useState({
    rootMessages: initialMounts.rootMessages ?? false,
    researcherMessagesA: initialMounts.researcherMessagesA ?? false,
    researcherMessagesB: initialMounts.researcherMessagesB ?? false,
    researcherToolCalls: initialMounts.researcherToolCalls ?? false,
    analystMessages: initialMounts.analystMessages ?? false,
  });

  const toggle = (key: keyof typeof mounts) =>
    setMounts((m) => ({ ...m, [key]: !m[key] }));

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="subagent-count">{subagents.length}</div>
      <RegistryDiagnostics stream={thread} />

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Run analysis")],
          })
        }
      >
        Run
      </button>

      <button
        data-testid="toggle-root-messages"
        onClick={() => toggle("rootMessages")}
      >
        Toggle root messages observer
      </button>
      <button
        data-testid="toggle-researcher-messages-a"
        onClick={() => toggle("researcherMessagesA")}
      >
        Toggle researcher messages observer A
      </button>
      <button
        data-testid="toggle-researcher-messages-b"
        onClick={() => toggle("researcherMessagesB")}
      >
        Toggle researcher messages observer B
      </button>
      <button
        data-testid="toggle-researcher-toolcalls"
        onClick={() => toggle("researcherToolCalls")}
      >
        Toggle researcher tool-calls observer
      </button>
      <button
        data-testid="toggle-analyst-messages"
        onClick={() => toggle("analystMessages")}
      >
        Toggle analyst messages observer
      </button>

      {mounts.rootMessages ? (
        <RootMessagesView stream={thread} />
      ) : null}

      {mounts.researcherMessagesA && researcher ? (
        <ScopedMessagesView
          stream={thread}
          subagent={researcher}
          id="researcher-a"
        />
      ) : null}

      {mounts.researcherMessagesB && researcher ? (
        <ScopedMessagesView
          stream={thread}
          subagent={researcher}
          id="researcher-b"
        />
      ) : null}

      {mounts.researcherToolCalls && researcher ? (
        <ScopedToolCallsView
          stream={thread}
          subagent={researcher}
          id="researcher-tc"
        />
      ) : null}

      {mounts.analystMessages && analyst ? (
        <ScopedMessagesView
          stream={thread}
          subagent={analyst}
          id="analyst"
        />
      ) : null}
    </div>
  );
}

function RegistryDiagnostics({ stream }: { stream: Thread }) {
  // The `[STREAM_CONTROLLER]` symbol is `@internal` but we use it here
  // purely for test observability — it gives us a cheap, referentially
  // stable view of `ChannelRegistry.size` without leaking more
  // diagnostic surface to user-space.
  //
  // We poll on a short interval so the displayed size reflects the
  // post-effect state: `useProjection` acquires / releases entries
  // inside a `useEffect`, which runs *after* React commits, so a
  // purely render-driven read would lag by one render cycle.
  const registry = stream[STREAM_CONTROLLER].registry;
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => {
      setTick((t) => t + 1);
    }, 25);
    return () => clearInterval(handle);
  }, []);
  return <div data-testid="registry-size">{registry.size}</div>;
}

function RootMessagesView({ stream }: { stream: Thread }) {
  // Root target (no second argument): this path is served by
  // `stream.messages` directly and MUST NOT acquire a registry entry.
  const messages = useMessages(stream);
  return <div data-testid="root-observer-count">{messages.length}</div>;
}

function ScopedMessagesView({
  stream,
  subagent,
  id,
}: {
  stream: Thread;
  subagent: SubagentDiscoverySnapshot;
  id: string;
}) {
  const messages = useMessages(stream, subagent);
  return (
    <div data-testid={`obs-${id}`}>
      <div data-testid={`obs-${id}-count`}>{messages.length}</div>
      <div data-testid={`obs-${id}-namespace`}>
        {subagent.namespace.join("/")}
      </div>
      <div data-testid={`obs-${id}-types`}>
        {messages.map((m) => m.getType()).join(",")}
      </div>
    </div>
  );
}

function ScopedToolCallsView({
  stream,
  subagent,
  id,
}: {
  stream: Thread;
  subagent: SubagentDiscoverySnapshot;
  id: string;
}) {
  const toolCalls = useToolCalls(stream, subagent);
  return (
    <div data-testid={`obs-${id}`}>
      <div data-testid={`obs-${id}-count`}>{toolCalls.length}</div>
      <div data-testid={`obs-${id}-names`}>
        {toolCalls.map((tc) => tc.name).join(",")}
      </div>
    </div>
  );
}
