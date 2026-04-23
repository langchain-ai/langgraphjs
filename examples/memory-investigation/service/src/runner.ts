/**
 * Deepagents runner — returns an SSE ReadableStream piped directly to
 * the HTTP response, exercising the real streaming/backpressure path.
 */
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import { buildAgent } from "./agent-setup.js";

const DEFAULT_MODEL = process.env.MODEL_NAME ?? "claude-haiku-4-5";

const DEFAULT_PROMPT = [
  "Research the top 3 programming languages by popularity in 2025.",
  "For each, find its creator, year created, and one unique feature.",
  "Return a summary table.",
].join(" ");

export interface RunOptions {
  message?: string;
  model?: string;
  streamMode?: ("messages" | "values" | "updates")[];
  subgraphs?: boolean;
}

/**
 * Run one deepagents invocation and return the SSE-encoded
 * ReadableStream. The caller pipes this directly into the HTTP
 * response — chunks flow over the wire as they're produced,
 * exercising the real backpressure path.
 */
export async function runStream(
  opts: RunOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const {
    message = DEFAULT_PROMPT,
    model: modelName = DEFAULT_MODEL,
    streamMode = ["messages", "updates", "values"],
    subgraphs = true,
  } = opts;

  const model = new ChatAnthropic({
    model: modelName,
    temperature: 0,
    streaming: true,
  });

  const agent = buildAgent({ model });

  // encoding: "text/event-stream" makes .stream() return a
  // ReadableStream<Uint8Array> with SSE-formatted bytes — the same
  // format LangGraph Server uses. This goes straight into a Response.
  const stream = await agent.stream(
    { messages: [new HumanMessage(message)] },
    {
      streamMode,
      subgraphs,
      encoding: "text/event-stream",
      configurable: { thread_id: `mre-${Date.now()}` },
    },
  );

  // stream is a ReadableStream<Uint8Array> (SSE-encoded)
  return stream;
}
