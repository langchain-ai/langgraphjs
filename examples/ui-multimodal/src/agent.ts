/**
 * Bedtime Story — a minimal `StateGraph` that fans out three parallel
 * multimodal generations after a single storyteller pass.
 *
 *     START
 *       │
 *       ▼
 *   storyteller           (gpt-5-mini, three paragraphs)
 *       │
 *       ├──▶ visualizer_0   │──▶ narrator_0   (pages emit in parallel)
 *       ├──▶ videographer_1 │──▶ narrator_1   (page 1 is a Sora video)
 *       └──▶ visualizer_2   │──▶ narrator_2
 *                                       │
 *                                       ▼
 *                                      END
 *
 * This replaces the earlier `createDeepAgent` implementation. deepagents
 * layered an LLM-driven coordinator on top of a `task` tool, which meant a
 * multi-turn chat routed every paragraph through an orchestration roundtrip
 * before any bytes reached the client. A straight StateGraph skips all of
 * that: as soon as `storyteller` writes `paragraphs` into state, the six
 * worker nodes fire in one superstep, so images and audio start streaming in
 * parallel alongside the last tokens of the story.
 *
 * Each node is a plain async function invoking its own model. Because
 * LangGraph assigns every node a distinct checkpoint namespace
 * (`<node_name>:<uuid>`), the client discovers each invocation via
 * subgraph-style namespaces and scopes `useImages` / `useAudio` /
 * `useMessages` to the right per-page slot with no shared-tool plumbing.
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { z } from "zod/v4";
import {
  END,
  MessagesValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { ChatOpenAI, tools as openaiTools } from "@langchain/openai";

const STORYTELLER_SYSTEM = `You are a gentle bedtime storyteller for children ages 3-7.

Write EXACTLY three short paragraphs (2-3 sentences each) telling one single,
cohesive, calming bedtime story based on the user's prompt.

Rules:
- Warm, soft, comforting tone. No violence, no scary imagery, no sharp conflict.
- Each paragraph must stand on its own as one page of a picture book — a
  self-contained tiny scene a child can picture.
- Separate the three paragraphs with a single blank line.
- Do not add a title, greeting, disclaimer, or closing remark. Output is
  exactly three paragraphs of prose and nothing else.`;

const VISUALIZER_SYSTEM = `You are an illustrator for a children's picture book.

The user message contains ONE paragraph of a bedtime story. Call the
image_generation tool exactly once to produce a single illustration for that
paragraph.

Style guide (apply every time):
- Soft watercolor, pastel palette, dreamy lighting.
- Rounded, cozy shapes. Gentle composition centered on the subject.
- No text, letters, signs, or writing anywhere in the image.
- No scary or sharp elements. No weapons.

After the tool call returns, reply with a single short sentence acknowledging
the illustration is ready. Do not describe the image.`;

const NARRATOR_SYSTEM = `You are a warm, gentle narrator reading a child to sleep.

Read the paragraph in the user message aloud at a calm, unhurried pace. Do NOT
add greetings, commentary, stage directions, or extra words. Speak only the
paragraph exactly as written.`;

/**
 * Style wrapper for the Sora 2 text prompt used by `videographer_1`.
 * Pairs a fixed "bedtime storybook animation" aesthetic with Sora's content
 * guardrails (no realistic humans, no text in frame, no scary motion) so the
 * model has a useful context window regardless of what the paragraph says.
 */
const VIDEOGRAPHER_PROMPT_PREFIX = `Soft watercolor animation for a children's bedtime picture book. \
Pastel palette, dreamy volumetric lighting, gentle camera drift, slow motion. \
Rounded, cozy shapes; no text, letters, or writing in frame; no scary or sharp \
elements; no photorealistic humans (use whimsical animal characters or cartoon \
silhouettes instead). Scene:`;

const SORA_MODEL = "sora-2";
const SORA_SECONDS = "4";
const SORA_SIZE = "720x1280";
/**
 * Wall-clock ceiling for a single Sora 2 render. The API returns `queued` /
 * `in_progress` status and we poll until `completed` or `failed`. If neither
 * happens within this window, the videographer node rejects so the graph
 * doesn't leave the client spinning forever.
 */
const SORA_MAX_WAIT_MS = 5 * 60 * 1000;
const SORA_POLL_INTERVAL_MS = 5_000;

interface SoraJob {
  readonly id: string;
  readonly status: "queued" | "in_progress" | "completed" | "failed";
  readonly progress?: number;
  readonly error?: { message?: string } | null;
}

/**
 * Read `OPENAI_API_KEY` once per call. Throws a user-visible message instead
 * of a raw `undefined` slice if the agent is running without the key set.
 */
const requireOpenAIKey = (): string => {
  const key = process.env.OPENAI_API_KEY;
  if (key == null || key.length === 0) {
    throw new Error(
      "OPENAI_API_KEY is not set; videographer_1 cannot call the Sora API"
    );
  }
  return key;
};

/**
 * Kick off a Sora 2 render. Returns the job id; poll
 * {@link pollSoraJob} against it until it settles.
 */
async function createSoraJob(prompt: string): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/videos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireOpenAIKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SORA_MODEL,
      prompt,
      seconds: SORA_SECONDS,
      size: SORA_SIZE,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Sora create failed: ${response.status} ${response.statusText} ${body}`
    );
  }
  const job = (await response.json()) as SoraJob;
  return job.id;
}

/**
 * Poll `GET /videos/{id}` at {@link SORA_POLL_INTERVAL_MS} intervals, giving
 * up after {@link SORA_MAX_WAIT_MS}. Resolves when the job transitions to
 * `completed`; rejects on `failed` or timeout.
 */
async function pollSoraJob(id: string): Promise<void> {
  const deadline = Date.now() + SORA_MAX_WAIT_MS;
  // oxlint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`Sora job ${id} did not complete within ${SORA_MAX_WAIT_MS}ms`);
    }
    const response = await fetch(`https://api.openai.com/v1/videos/${id}`, {
      headers: { Authorization: `Bearer ${requireOpenAIKey()}` },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Sora retrieve failed: ${response.status} ${response.statusText} ${body}`
      );
    }
    const job = (await response.json()) as SoraJob;
    if (job.status === "completed") return;
    if (job.status === "failed") {
      const reason = job.error?.message ?? "unknown";
      throw new Error(`Sora job ${id} failed: ${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, SORA_POLL_INTERVAL_MS));
  }
}

/**
 * Download the final MP4 bytes for a completed Sora job. The endpoint
 * streams binary content; we materialise the full buffer so the caller can
 * base64-encode it into a protocol VideoBlock.
 */
async function downloadSoraVideo(id: string): Promise<Uint8Array> {
  const response = await fetch(
    `https://api.openai.com/v1/videos/${id}/content`,
    {
      headers: { Authorization: `Bearer ${requireOpenAIKey()}` },
    }
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Sora download failed: ${response.status} ${response.statusText} ${body}`
    );
  }
  const buf = await response.arrayBuffer();
  return new Uint8Array(buf);
}

const storytellerModel = new ChatOpenAI({ model: "gpt-5.4-mini" });

const visualizerModel = new ChatOpenAI({
  model: "gpt-5.4-mini",
  useResponsesApi: true,
}).bindTools([
  openaiTools.imageGeneration({
    size: "1024x1024",
    quality: "medium",
    outputFormat: "png",
  }),
]);

const narratorModel = new ChatOpenAI({
  model: "gpt-4o-audio-preview",
  modalities: ["text", "audio"],
  audio: { voice: "nova", format: "pcm16" },
  streaming: true,
});

const splitParagraphs = (text: string): string[] =>
  text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .slice(0, 3);

/**
 * Strips large binary payloads (PCM16 audio, base64 images) from
 * `additional_kwargs` before the message flows into graph state.
 *
 * Both modalities are delivered to the client via streaming protocol
 * events (`content-block-start` / `content-block-delta` / …), so the
 * raw bytes don't need to live in the final `AIMessage`. Leaving them
 * in state causes two compounding problems:
 *
 *  1. Every superstep checkpoint captures a full state snapshot, so each
 *     2 MB audio message multiplies across all future checkpoints on the
 *     thread.
 *  2. `FileSystemPersistence` serializes the entire `MemorySaver` store
 *     (all threads, all checkpoints) through a single `JSON.stringify`.
 *     After a handful of bedtime stories the resulting string breaches
 *     V8's max string length and crashes with
 *     `RangeError: Invalid string length`.
 *
 * We keep the metadata (transcripts, mime types, ids, sizes) — which is
 * useful for rehydrating the UI — and drop only the opaque binary blobs.
 */
function stripHeavyBinaries(message: AIMessage): AIMessage {
  const additionalKwargs = message.additional_kwargs ?? {};
  let mutated = false;

  const nextAdditionalKwargs: Record<string, unknown> = { ...additionalKwargs };

  const audio = (additionalKwargs as { audio?: unknown }).audio;
  if (audio != null && typeof audio === "object") {
    const audioRecord = audio as Record<string, unknown>;
    if (typeof audioRecord.data === "string" && audioRecord.data.length > 0) {
      const { data: _dropped, ...rest } = audioRecord;
      void _dropped;
      nextAdditionalKwargs.audio = rest;
      mutated = true;
    }
  }

  const toolOutputs = (additionalKwargs as { tool_outputs?: unknown })
    .tool_outputs;
  if (Array.isArray(toolOutputs)) {
    const sanitizedOutputs = toolOutputs.map((entry) => {
      if (entry == null || typeof entry !== "object") return entry;
      const record = entry as Record<string, unknown>;
      if (
        record.type === "image_generation_call" &&
        typeof record.result === "string" &&
        record.result.length > 0
      ) {
        const { result: _dropped, ...rest } = record;
        void _dropped;
        mutated = true;
        return rest;
      }
      return entry;
    });
    if (mutated) nextAdditionalKwargs.tool_outputs = sanitizedOutputs;
  }

  // Defensive scrub for raw base64 on inline media content blocks.
  //
  // NOTE: do NOT pipe the videographer node's output through this helper.
  // Unlike the visualizer / narrator nodes (which emit their bytes via
  // LLM streaming callbacks before the final message lands in state),
  // the videographer builds its message synchronously after the Sora
  // download completes. The messages-v2 engine emits protocol events by
  // reading the final-state message, so stripping `data` here would
  // ship payload-less `content-block-*` events and the client would
  // never see the MP4. This branch only runs if a future node happens
  // to express images/audio as inline blocks after their own streaming
  // emitter has already flushed the bytes to the wire.
  let nextContent: AIMessage["content"] = message.content;
  if (Array.isArray(message.content)) {
    let contentMutated = false;
    const scrubbed = message.content.map((block) => {
      if (block == null || typeof block !== "object") return block;
      const record = block as Record<string, unknown>;
      const type = record.type;
      const isMediaBlock =
        type === "video" || type === "image" || type === "audio" || type === "file";
      if (!isMediaBlock) return block;
      if (typeof record.data !== "string" || record.data.length === 0) return block;
      const { data: _dropped, ...rest } = record;
      void _dropped;
      contentMutated = true;
      return rest as typeof block;
    });
    if (contentMutated) {
      nextContent = scrubbed as AIMessage["content"];
      mutated = true;
    }
  }

  if (!mutated) return message;

  return new AIMessage({
    ...message,
    content: nextContent,
    additional_kwargs: nextAdditionalKwargs,
  });
}

const State = new StateSchema({
  messages: MessagesValue,
  paragraphs: z.array(z.string()).default(() => []),
});

type StoryState = typeof State.State;

const storytellerNode = async (state: StoryState) => {
  const lastHuman = [...state.messages]
    .reverse()
    .find(HumanMessage.isInstance);
  const prompt = lastHuman != null ? lastHuman.text : "";

  const response = await storytellerModel.invoke([
    new SystemMessage(STORYTELLER_SYSTEM),
    new HumanMessage(prompt),
  ]);

  const paragraphs = splitParagraphs(response.text);
  return { messages: [response], paragraphs };
};

const makeVisualizerNode =
  (index: number) =>
  async (state: StoryState) => {
    const paragraph = state.paragraphs[index];
    if (paragraph == null || paragraph.length === 0) return {};
    const response = await visualizerModel.invoke([
      new SystemMessage(VISUALIZER_SYSTEM),
      new HumanMessage(paragraph),
    ]);
    // Name the message so the client can trace it back to a page slot
    // even when it renders via root-scoped selectors, and strip the
    // base64 image payload so it never hits the persisted checkpoint.
    const named = new AIMessage({
      ...response,
      name: `visualizer_${index}`,
    });
    return { messages: [stripHeavyBinaries(named)] };
  };

const makeNarratorNode =
  (index: number) =>
  async (state: StoryState) => {
    const paragraph = state.paragraphs[index];
    if (paragraph == null || paragraph.length === 0) return {};
    const response = await narratorModel.invoke([
      new SystemMessage(NARRATOR_SYSTEM),
      new HumanMessage(paragraph),
    ]);
    const named = new AIMessage({
      ...response,
      name: `narrator_${index}`,
    });
    return { messages: [stripHeavyBinaries(named)] };
  };

/**
 * Sora-powered illustrator for page `index`. Submits the paragraph (plus a
 * fixed style prefix) to the Videos API, polls until completion, downloads
 * the MP4, and emits an `AIMessage` with a single `video` content block.
 *
 * Unlike the visualizer / narrator nodes, this one must NOT be run through
 * `stripHeavyBinaries`. Those nodes can afford to strip their payloads
 * because the OpenAI Responses / audio-preview models stream the bytes out
 * via LLM callbacks while the node is still executing — the messages-v2
 * engine emits those as `content-block-delta` events long before the final
 * message lands in state. The videographer has no such in-flight streaming
 * emitter; it constructs the message synchronously after the Sora download
 * completes, so the messages-v2 engine only ever sees the final-state
 * message. Stripping `data` here would make every `content-block-*` event
 * ship without a payload and the client would spin on "queuing…" forever.
 *
 * The tradeoff is that the MP4 base64 (~0.5–2 MB for a 4s/720p clip)
 * persists in the thread's checkpoints. That's on the same order as the
 * PCM-16 and PNG payloads that the other nodes emit during streaming, so
 * a single demo thread is well within V8 string limits. For production
 * usage you'd want to swap the inline bytes for an external asset ref.
 */
const makeVideographerNode =
  (index: number) =>
  async (state: StoryState) => {
    const paragraph = state.paragraphs[index];
    if (paragraph == null || paragraph.length === 0) return {};

    const prompt = `${VIDEOGRAPHER_PROMPT_PREFIX}\n\n${paragraph}`;
    const jobId = await createSoraJob(prompt);
    await pollSoraJob(jobId);
    const mp4 = await downloadSoraVideo(jobId);
    const base64 = Buffer.from(mp4).toString("base64");

    const named = new AIMessage({
      name: `videographer_${index}`,
      content: [
        {
          type: "video",
          data: base64,
          mime_type: "video/mp4",
        },
      ],
    });
    return { messages: [named] };
  };

const WORKER_NODES = [
  "visualizer_0",
  "videographer_1",
  "visualizer_2",
  "narrator_0",
  "narrator_1",
  "narrator_2",
] as const;

const builder = new StateGraph(State)
  .addNode("storyteller", storytellerNode)
  .addNode("visualizer_0", makeVisualizerNode(0))
  .addNode("videographer_1", makeVideographerNode(1))
  .addNode("visualizer_2", makeVisualizerNode(2))
  .addNode("narrator_0", makeNarratorNode(0))
  .addNode("narrator_1", makeNarratorNode(1))
  .addNode("narrator_2", makeNarratorNode(2))
  .addEdge(START, "storyteller");

for (const node of WORKER_NODES) {
  builder.addEdge("storyteller", node);
  builder.addEdge(node, END);
}

export const graph = builder.compile();
