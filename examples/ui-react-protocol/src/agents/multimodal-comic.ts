import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, createAgent, HumanMessage } from "langchain";
import { RunnableLambda } from "@langchain/core/runnables";
import { z } from "zod/v4";

import { modelName } from "./shared";

const checkpointer = new MemorySaver();
const globalProcess = globalThis as {
  process?: {
    env?: Record<string, string | undefined>;
  };
};
const comicImageChatModelName =
  globalProcess.process?.env?.OPENAI_IMAGE_CHAT_MODEL ?? modelName;
const comicAudioChatModelName =
  globalProcess.process?.env?.OPENAI_AUDIO_CHAT_MODEL ?? "tts-1";
const ttsVoiceAllowlist = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);
const configuredComicAudioVoice =
  globalProcess.process?.env?.OPENAI_AUDIO_VOICE ?? "sage";
const comicAudioVoice = ttsVoiceAllowlist.has(configuredComicAudioVoice)
  ? configuredComicAudioVoice
  : "sage";

const openAIBaseUrl = (
  globalProcess.process?.env?.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
).replace(/\/$/, "");

const chapterPlanSchema = z.object({
  chapterNumber: z.number().int().positive(),
  title: z.string().min(1),
  brief: z.string().min(1),
  imagePrompt: z.string().min(1),
  colorMood: z.string().min(1),
  voiceStyle: z.string().min(1),
});

const storyOutlineSchema = z.object({
  kind: z.literal("story-outline"),
  storyTitle: z.string().min(1),
  logline: z.string().min(1),
  chapterCount: z.number().int().positive().max(6),
  chapters: z.array(chapterPlanSchema).min(1).max(6),
});

const chapterScriptSchema = z.object({
  kind: z.literal("chapter-script"),
  chapterNumber: z.number().int().positive(),
  title: z.string().min(1),
  narration: z.string().min(1),
  dialogue: z.string().min(1),
  caption: z.string().min(1),
});

const getOpenAIApiKey = () => {
  const apiKey = globalProcess.process?.env?.OPENAI_API_KEY;
  if (apiKey == null || apiKey.trim().length === 0) {
    throw new Error(
      "OPENAI_API_KEY is required for multimodal comic speech generation."
    );
  }
  return apiKey;
};

const getOpenAIErrorMessage = async (response: Response) => {
  try {
    const data = (await response.json()) as {
      error?: {
        message?: string;
      };
    };
    return data.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
};

const extractJsonObjects = (value: string) => {
  const candidates: Array<Record<string, unknown>> = [];

  for (const fencedMatch of value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fencedBody = fencedMatch[1]?.trim();
    if (!fencedBody) continue;
    try {
      const parsed = JSON.parse(fencedBody) as Record<string, unknown>;
      candidates.push(parsed);
    } catch {
      // Fall through to the brace scanner below.
    }
  }

  const rawText = value.trim();
  for (let start = 0; start < rawText.length; start += 1) {
    if (rawText[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < rawText.length; end += 1) {
      const character = rawText[end];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") {
        depth += 1;
        continue;
      }
      if (character !== "}") continue;

      depth -= 1;
      if (depth !== 0) continue;

      try {
        const parsed = JSON.parse(rawText.slice(start, end + 1)) as Record<
          string,
          unknown
        >;
        candidates.push(parsed);
      } catch {
        // Ignore invalid balanced substrings.
      }
      break;
    }
  }

  return candidates;
};

const extractJsonObject = (value: string) => {
  const candidates = extractJsonObjects(value);
  const narrationCandidate = [...candidates]
    .reverse()
    .find(
      (candidate) =>
        typeof candidate.narration === "string" &&
        candidate.narration.trim().length > 0
    );
  if (narrationCandidate != null) return narrationCandidate;

  const chapterCandidate = [...candidates]
    .reverse()
    .find((candidate) => typeof candidate.chapterNumber === "number");
  if (chapterCandidate != null) return chapterCandidate;

  throw new Error("Voice-director task did not include valid chapter JSON.");
};

const estimateDurationSeconds = (transcript: string) => {
  const wordCount = transcript.trim().split(/\s+/).filter(Boolean).length;
  return Number(Math.max(1, (wordCount / 150) * 60).toFixed(2));
};

const chapterIllustrationModel = new ChatOpenAI({
  model: comicImageChatModelName,
  useResponsesApi: true,
  temperature: 0.3,
}).bindTools([
  {
    type: "image_generation",
    quality: "medium",
  },
]);

const storyPlannerAgent = createAgent({
  model: modelName,
  responseFormat: storyOutlineSchema,
  systemPrompt: `You are the story planner for a multimodal comic strip.

The task description includes the user's concept and the exact requested chapter
count. Produce exactly that many chapters and keep the story cohesive.

Rules:
- Return a structured response matching the schema.
- Set kind to "story-outline".
- Keep each brief to 1-2 sentences.
- Keep imagePrompt visually concrete.
- Keep voiceStyle short, like "warm bedtime narrator" or "dramatic radio host".
- Keep the chapter count exact. If the task does not specify one, use 1.`,
});

const chapterIllustratorAgent = createAgent({
  model: chapterIllustrationModel,
  systemPrompt: `You are the chapter illustrator.

The task description includes the full chapter JSON from the planner. Use that
to create one comic-panel illustration.

Rules:
- Use your built-in image generation capability to produce exactly one image.
- Return an AI message whose content includes the generated image.
- Optionally include one short caption sentence as text content after the image.
- Do not return JSON, markdown fences, or explanatory paragraphs.`,
});

const narrationWriterAgent = createAgent({
  model: modelName,
  responseFormat: chapterScriptSchema,
  systemPrompt: `You are the narration writer.

The task description includes the full chapter JSON from the planner.

Rules:
- Return a structured response matching the schema.
- Set kind to "chapter-script".
- Write 2-4 sentences of narration.
- Also write one short dialogue line and one short caption.
- Preserve the chapter number and title from the task.`,
});

const voiceDirectorAgent = RunnableLambda.from(
  async (input: { messages?: HumanMessage[] | unknown[] }) => {
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const lastMessage = messages.at(-1);
    const rawContent =
      lastMessage instanceof HumanMessage
        ? typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content)
        : typeof (lastMessage as { content?: unknown } | undefined)?.content ===
              "string"
          ? ((lastMessage as { content: string }).content ?? "")
          : "";

    const chapter = extractJsonObject(rawContent);
    const transcript =
      typeof chapter.narration === "string" ? chapter.narration.trim() : "";
    if (transcript.length === 0) {
      throw new Error("Voice-director task is missing narration text.");
    }

    const voiceStyle =
      typeof chapter.voiceStyle === "string" && chapter.voiceStyle.trim().length > 0
        ? chapter.voiceStyle.trim()
        : "Warm, clear comic narrator.";

    const response = await fetch(`${openAIBaseUrl}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getOpenAIApiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: comicAudioChatModelName,
        voice: comicAudioVoice,
        input: transcript,
        instructions: `Narrate this comic chapter in the following style: ${voiceStyle}`,
        response_format: "wav",
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI speech request failed (${response.status}): ${await getOpenAIErrorMessage(
          response
        )}`
      );
    }

    const audioBytes = Buffer.from(await response.arrayBuffer());
    const audioData = audioBytes.toString("base64");

    return {
      messages: [
        new AIMessage({
          content: transcript,
          additional_kwargs: {
            audio: {
              data: audioData,
              transcript,
              voice: comicAudioVoice,
              model: comicAudioChatModelName,
              durationSeconds: estimateDurationSeconds(transcript),
            },
          },
        }),
      ],
    };
  }
);

export const agent = createDeepAgent({
  model: modelName,
  checkpointer,
  subagents: [
    {
      name: "story-planner",
      description:
        "Creates the comic-strip arc and chapter plan from the user's concept.",
      runnable: storyPlannerAgent,
    },
    {
      name: "chapter-illustrator",
      description:
        "Turns one chapter brief into a rendered comic panel image asset.",
      runnable: chapterIllustratorAgent,
    },
    {
      name: "narration-writer",
      description:
        "Writes the narration text and caption for one specific chapter.",
      runnable: narrationWriterAgent,
    },
    {
      name: "voice-director",
      description:
        "Converts one chapter's narration into an AI-generated voice clip asset.",
      runnable: voiceDirectorAgent,
    },
  ],
  systemPrompt: `You are the multimodal comic strip coordinator.

Your job is to turn the user's concept into a comic strip that includes image,
text, and audio per chapter.

Workflow:
1. Launch exactly one task for story-planner first.
2. Once you have the structured outline, launch all chapter-illustrator and
   narration-writer tasks in parallel where possible. Use the task tool with
   subagent_type and description.
3. As soon as a chapter's narration is ready, launch the voice-director task for
   that same chapter. Voice tasks for different chapters should run in parallel.
4. Keep the requested chapter count exact. If the user does not specify one,
   default to 1. Never invent a different count.
5. Finish with a short natural-language summary of what was generated.

Task formatting rules:
- The story-planner description must clearly repeat the requested chapter count.
- Chapter task descriptions should include the full chapter JSON from the
  planner so each subagent can work independently.
- Use subagent_type values exactly as registered:
  story-planner, chapter-illustrator, narration-writer, voice-director.
- Prefer broad fan-out over sequential chapter-by-chapter execution.

The frontend renders assets from the subagents' structured JSON outputs, so do
not rewrite or paraphrase those JSON payloads in the task descriptions after you
receive them. Pass them through faithfully.`,
});
