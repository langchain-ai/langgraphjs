/**
 * Timeline stream transformer — projects raw protocol events onto a
 * curated remote {@link StreamChannel} named `"timeline"`.
 *
 * The point of this example is to show that a single custom stream
 * channel is enough to power a rich, typed UI. The browser never has
 * to parse `messages`, `tools`, `values`, or `lifecycle` events —
 * everything it needs is shaped server-side into a small,
 * domain-specific {@link TimelineEvent} union and pushed onto
 * `custom:timeline`.
 *
 * The transformer tracks:
 *   - Tool invocation start/stop (with durations and argument previews)
 *   - Assistant "thoughts" (final text and token usage per message)
 *   - Run boundaries (start/finish/fail) with aggregated totals
 *
 * None of the agent code knows about the UI — the transformer is the
 * only thing that has to change when the timeline schema evolves.
 */

import type {
  MessagesEventData,
  ProtocolEvent,
  StreamTransformer,
  ToolsEventData,
} from "@langchain/langgraph";
import { StreamChannel } from "@langchain/langgraph";

export type TimelineStatus = "ok" | "error";

export type ToolPhase =
  | "search"
  | "summarize"
  | "score"
  | "compute"
  | "research"
  | "other";

export type TimelineEvent =
  | {
      kind: "run-started";
      id: string;
      at: number;
    }
  | {
      kind: "tool-started";
      id: string;
      at: number;
      tool: string;
      phase: ToolPhase;
      label: string;
      argsPreview: string;
    }
  | {
      kind: "tool-finished";
      id: string;
      at: number;
      tool: string;
      phase: ToolPhase;
      label: string;
      durationMs: number;
      status: TimelineStatus;
      outputPreview: string;
    }
  | {
      kind: "thought";
      id: string;
      at: number;
      text: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      kind: "run-finished";
      id: string;
      at: number;
      durationMs: number;
      totalTokens: number;
      totalTools: number;
      status: TimelineStatus;
      errorMessage?: string;
    };

const PHASE_FROM_TOOL: Record<string, ToolPhase> = {
  search_web: "search",
  summarize_findings: "summarize",
  score_risks: "score",
  calculator: "compute",
  deep_research: "research",
};

const PHASE_LABEL: Record<ToolPhase, string> = {
  search: "Searching the web",
  summarize: "Summarising findings",
  score: "Scoring risks",
  compute: "Running a calculation",
  research: "Deep research",
  other: "Tool call",
};

const MAX_PREVIEW = 160;
const MAX_THOUGHT = 280;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const preview = (value: unknown, max = MAX_PREVIEW): string => {
  if (value == null) return "";
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
};

/**
 * Creates a {@link StreamTransformer} that exposes a single remote `timeline`
 * {@link StreamChannel}. Plug into `createAgent({ streamTransformers })`
 * or `.compile({ transformers: [...] })`.
 */
export const createTimelineTransformer = (): StreamTransformer<{
  timeline: StreamChannel<TimelineEvent>;
}> => {
  const timeline = StreamChannel.remote<TimelineEvent>("timeline");

  const startedAt = Date.now();
  const toolStartedAt = new Map<
    string,
    { at: number; tool: string; phase: ToolPhase }
  >();

  let totalTokens = 0;
  let totalTools = 0;
  let nextId = 0;
  let runStartedEmitted = false;

  const id = (): string => `tl-${++nextId}`;

  return {
    init: () => ({ timeline }),

    process(event: ProtocolEvent): boolean {
      // The mux wires the channel AFTER `init()` returns, so we can't
      // push from the factory body or `init()` — those pushes land in
      // the in-process channel only and never reach remote
      // subscribers. Emit `run-started` on the first event instead,
      // which is guaranteed to run after wiring is in place.
      if (!runStartedEmitted) {
        runStartedEmitted = true;
        timeline.push({
          kind: "run-started",
          id: id(),
          at: startedAt,
        });
      }

      if (event.method === "tools") {
        const data = event.params.data as ToolsEventData;

        if (data.event === "tool-started") {
          const phase = PHASE_FROM_TOOL[data.tool_name] ?? "other";
          toolStartedAt.set(data.tool_call_id, {
            at: Date.now(),
            tool: data.tool_name,
            phase,
          });
          totalTools += 1;
          timeline.push({
            kind: "tool-started",
            id: id(),
            at: Date.now(),
            tool: data.tool_name,
            phase,
            label: PHASE_LABEL[phase],
            argsPreview: preview(data.input),
          });
        }

        if (data.event === "tool-finished" || data.event === "tool-error") {
          const started = toolStartedAt.get(data.tool_call_id);
          const status: TimelineStatus =
            data.event === "tool-error" ? "error" : "ok";
          const at = Date.now();
          const durationMs = started ? at - started.at : 0;
          const phase = started?.phase ?? "other";
          const tool = started?.tool ?? "unknown";
          const output =
            data.event === "tool-error"
              ? (data as { message?: string }).message ?? "Tool failed"
              : (data as { output?: unknown }).output;
          timeline.push({
            kind: "tool-finished",
            id: id(),
            at,
            tool,
            phase,
            label: PHASE_LABEL[phase],
            durationMs,
            status,
            outputPreview: preview(output),
          });
          toolStartedAt.delete(data.tool_call_id);
        }

        return true;
      }

      if (event.method === "messages") {
        const data = event.params.data as MessagesEventData;
        if (data.event !== "message-finish") return true;

        // Only surface final assistant prose — skip tool-call messages,
        // the agent's user echo, and empty finishes.
        const role = (data as { role?: string }).role;
        if (role != null && role !== "ai") return true;

        const inputTokens = data.usage?.input_tokens ?? 0;
        const outputTokens = data.usage?.output_tokens ?? 0;
        totalTokens += inputTokens + outputTokens;

        // `message-finish` carries the final text across the SDK's
        // reducers — look for it on the canonical fields first, then fall
        // back to scanning `content` blocks for any text chunks.
        const text = extractAssistantText(data);
        if (!text) return true;

        timeline.push({
          kind: "thought",
          id: id(),
          at: Date.now(),
          text: preview(text, MAX_THOUGHT),
          inputTokens,
          outputTokens,
        });
      }

      return true;
    },

    finalize() {
      timeline.push({
        kind: "run-finished",
        id: id(),
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        totalTokens,
        totalTools,
        status: "ok",
      });
    },

    fail(err) {
      const errorMessage =
        isRecord(err) && typeof err.message === "string"
          ? err.message
          : String(err);
      timeline.push({
        kind: "run-finished",
        id: id(),
        at: Date.now(),
        durationMs: Date.now() - startedAt,
        totalTokens,
        totalTools,
        status: "error",
        errorMessage,
      });
    },
  };
};

/**
 * The SDK's reducers may place the final assistant text in a handful of
 * slightly different shapes depending on the provider. Walk the common
 * ones so a single transformer works for every model.
 */
function extractAssistantText(data: MessagesEventData): string {
  const anyData = data as unknown as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof anyData.text === "string" && anyData.text.trim().length > 0) {
    return anyData.text.trim();
  }

  if (Array.isArray(anyData.content)) {
    const parts: string[] = [];
    for (const block of anyData.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("").trim();
  }

  return "";
}
