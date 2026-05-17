/**
 * Bedtime Story — a minimal `StateGraph` that fans out three parallel
 * multimodal generations after a single storyteller pass.
 *
 *     START
 *       │
 *       ▼
 *   storyteller           (gpt-5-mini, three paragraphs)
 *       │
 *       ├──▶ visualizer_0   │──▶ narrator_0
 *       ├──▶ visualizer_1   │──▶ narrator_1
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
  let nextContent: AIMessage["content"] = message.content;
  if (Array.isArray(message.content)) {
    let contentMutated = false;
    const scrubbed = message.content.map((block) => {
      if (block == null || typeof block !== "object") return block;
      const record = block as Record<string, unknown>;
      const type = record.type;
      const isMediaBlock =
        type === "image" || type === "audio" || type === "file";
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
  // `paragraphs` is the coordination channel between the storyteller and the
  // six media workers. Once populated, all visualizers and narrators can run in
  // parallel using their page index.
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

/**
 * Creates one image-generation worker for a specific story page.
 *
 * Each worker has a unique graph node name (`visualizer_0`, etc.), which gives
 * the React client a stable lifecycle namespace to target with `useImages`.
 */
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

/**
 * Creates one audio-generation worker for a specific story page.
 *
 * Audio streams as PCM16 chunks over the protocol while the final message is
 * sanitized before checkpointing, keeping the demo responsive and avoiding
 * large binary blobs in persisted graph state.
 */
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

const WORKER_NODES = [
  "visualizer_0",
  "visualizer_1",
  "visualizer_2",
  "narrator_0",
  "narrator_1",
  "narrator_2",
] as const;

// All worker edges leave `storyteller`, so LangGraph schedules the three image
// generations and three narrations in the same superstep.
const builder = new StateGraph(State)
  .addNode("storyteller", storytellerNode)
  .addNode("visualizer_0", makeVisualizerNode(0))
  .addNode("visualizer_1", makeVisualizerNode(1))
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
