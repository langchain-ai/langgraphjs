import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "langchain";
import { z } from "zod/v4";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const globalProcess = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};

export const modelName =
  globalProcess.process?.env?.ANTHROPIC_MODEL ?? "claude-haiku-4-5";

export const model = new ChatAnthropic({
  model: modelName,
  temperature: 0.2,
});

type CapabilityKey =
  | "session"
  | "subscription"
  | "messages"
  | "tools"
  | "lifecycle"
  | "reconnect";

const CAPABILITY_LIBRARY: Record<
  CapabilityKey,
  {
    summary: string;
    notes: string[];
  }
> = {
  session: {
    summary: "Session establishment and capability discovery.",
    notes: [
      "The client begins with session.open before using protocol modules.",
      "The server replies with sessionId, transport details, and capabilities.",
      "Capabilities are session-scoped so supported channels can vary by target.",
    ],
  },
  subscription: {
    summary: "Server-side filtering by channels and namespaces.",
    notes: [
      "subscription.subscribe selects channels like messages, tools, and lifecycle.",
      "Namespace prefixes let the server scope events to a subagent tree.",
      "The server may replay buffered events when a subscription is created.",
    ],
  },
  messages: {
    summary: "Content-block lifecycle events replace chunk-only streaming.",
    notes: [
      "Messages stream through message-start, content-block-start/delta/finish, and message-finish.",
      "Text, reasoning, and tool call blocks can all share the same lifecycle model.",
      "The SDK adapts these protocol events back into the familiar messages tuple stream.",
    ],
  },
  tools: {
    summary: "Explicit tool lifecycle visibility for frontend consumers.",
    notes: [
      "The tools channel distinguishes tool-started, tool-output-delta, tool-finished, and tool-error.",
      "Tool execution is separate from the model's tool-call generation events in messages.",
      "This makes it easy to render tool progress independently from assistant text.",
    ],
  },
  lifecycle: {
    summary: "Subagent tree lifecycle updates for hierarchical runs.",
    notes: [
      "The lifecycle channel emits spawned, running, completed, failed, and interrupted events.",
      "Agent identity is carried in params.namespace instead of a separate agent ID field.",
      "Deep Agent frontends can use this to render nested work as it starts and finishes.",
    ],
  },
  reconnect: {
    summary: "Replay-aware recovery using event IDs and sequence numbers.",
    notes: [
      "subscription.reconnect lets a client restore subscriptions after disconnects.",
      "SSE event ordering is anchored by seq and command responses expose appliedThroughSeq.",
      "A bounded event buffer supports replay until the server requires snapshot recovery.",
    ],
  },
};

const normalizeCapabilityKey = (area: string): CapabilityKey => {
  const normalized = area.toLowerCase();
  if (normalized.includes("tool")) return "tools";
  if (normalized.includes("message")) return "messages";
  if (normalized.includes("life")) return "lifecycle";
  if (normalized.includes("reconnect")) return "reconnect";
  if (normalized.includes("sub")) return "subscription";
  return "session";
};

export const lookupProtocolCapability = tool(
  async ({ area }: { area: string }) => {
    await sleep(250);
    const key = normalizeCapabilityKey(area);
    const entry = CAPABILITY_LIBRARY[key];
    return JSON.stringify(
      {
        area: key,
        summary: entry.summary,
        notes: entry.notes,
      },
      null,
      2
    );
  },
  {
    name: "lookup_protocol_capability",
    description:
      "Look up a concise explanation of a protocol area such as session, subscription, messages, tools, lifecycle, or reconnect.",
    schema: z.object({
      area: z.string().describe("The protocol area to explain."),
    }),
  }
);

export const draftProtocolChecklist = tool(
  async ({
    goal,
    agentType,
  }: {
    goal: string;
    agentType: "stategraph" | "create-agent" | "deep-agent";
  }) => {
    await sleep(400);
    return JSON.stringify(
      {
        goal,
        agentType,
        checklist: [
          `Confirm ${agentType} is exposed through langgraph.json with a stable assistant id.`,
          "Open a run from the frontend with streamProtocol set to v2-sse.",
          "Render messages plus at least one diagnostic surface such as tools or state updates.",
          "Verify the flow works across a fresh thread and a follow-up message.",
          "Document what the protocol adds for this goal and where the UX still feels rough.",
        ],
      },
      null,
      2
    );
  },
  {
    name: "draft_protocol_checklist",
    description:
      "Draft a short checklist for testing or exploring a protocol-backed frontend workflow.",
    schema: z.object({
      goal: z.string().describe("The exploration or testing goal."),
      agentType: z
        .enum(["stategraph", "create-agent", "deep-agent"])
        .describe("The runtime shape being exercised."),
    }),
  }
);

export const reviewProtocolRisks = tool(
  async ({ surface }: { surface: string }) => {
    await sleep(325);
    return JSON.stringify(
      {
        surface,
        risks: [
          "Messages can look fine while tool or lifecycle events are silently missing.",
          "Subagent-heavy runs need clear namespace-aware UI or the trace gets hard to follow.",
          "Reconnect behavior needs validation when a stream is interrupted mid-run.",
          "State snapshots can become noisy unless the UI makes large values easy to scan.",
        ],
      },
      null,
      2
    );
  },
  {
    name: "review_protocol_risks",
    description:
      "Review common product and testing risks for a streaming surface that uses the new protocol.",
    schema: z.object({
      surface: z
        .string()
        .describe("The frontend or server surface being reviewed."),
    }),
  }
);

export const basicProtocolTools = [
  lookupProtocolCapability,
  draftProtocolChecklist,
] as const;

export const protocolTools = [
  lookupProtocolCapability,
  draftProtocolChecklist,
  reviewProtocolRisks,
] as const;

export const protocolSystemPrompt = `You are helping evaluate the new LangGraph streaming protocol.

Prefer answers that are concrete, implementation-aware, and short enough to scan in a UI.
Use tools when the user asks for protocol details, a test plan, or tradeoffs. When you use
tool results, synthesize them instead of dumping raw JSON back to the user.`;
