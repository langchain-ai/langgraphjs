import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import {
  AIMessage,
  type BaseMessage,
  type BaseMessageFields,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";

const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

const MINIMAX_MODELS = [
  "MiniMax-M2.7",
  "MiniMax-M2.7-highspeed",
  "MiniMax-M2.5",
  "MiniMax-M2.5-highspeed",
] as const;

type MiniMaxModel = (typeof MINIMAX_MODELS)[number];

const THINK_TAG_REGEX = /<think>[\s\S]*?<\/think>/g;

/**
 * Clamp temperature to MiniMax's accepted range.
 * MiniMax accepts temperature in [0, 1.0].
 */
function clampTemperature(temperature: number | undefined): number {
  if (temperature === undefined || temperature === null) return 0.01;
  return Math.max(0, Math.min(1, temperature));
}

/**
 * Strip `<think>...</think>` blocks from a message's content.
 * MiniMax M2.5+ models may include reasoning traces wrapped in think tags.
 */
function stripThinkTags(content: string): string {
  return content.replace(THINK_TAG_REGEX, "").trim();
}

export interface ChatMiniMaxFields extends Omit<ChatOpenAIFields, "model"> {
  /**
   * MiniMax model to use. Defaults to "MiniMax-M2.7".
   */
  model?: MiniMaxModel | (string & {});

  /**
   * Whether to strip `<think>` reasoning tags from responses.
   * Defaults to true.
   */
  stripThinking?: boolean;
}

/**
 * Chat model wrapper for MiniMax's OpenAI-compatible API.
 *
 * MiniMax provides large language models (M2.7, M2.5, etc.) accessible via
 * an OpenAI-compatible API endpoint at `https://api.minimax.io/v1`.
 *
 * This class extends `ChatOpenAI` with MiniMax-specific handling:
 * - Automatic temperature clamping to [0, 1.0]
 * - Stripping of `<think>` reasoning tags from M2.5+ model responses
 * - Pre-configured base URL for the MiniMax API
 *
 * @example
 * ```ts
 * import { ChatMiniMax } from "@langchain/langgraph-supervisor";
 *
 * const model = new ChatMiniMax({
 *   model: "MiniMax-M2.7",
 *   apiKey: process.env.MINIMAX_API_KEY,
 * });
 * ```
 */
export class ChatMiniMax extends ChatOpenAI {
  stripThinking: boolean;

  constructor(fields?: ChatMiniMaxFields) {
    const {
      stripThinking = true,
      model = "MiniMax-M2.7",
      temperature,
      ...rest
    } = fields ?? {};

    super({
      ...rest,
      model,
      temperature: clampTemperature(temperature),
      apiKey: rest.apiKey ?? process.env.MINIMAX_API_KEY,
      configuration: {
        ...rest.configuration,
        baseURL: rest.configuration?.baseURL ?? MINIMAX_BASE_URL,
      },
    });

    this.stripThinking = stripThinking;
  }

  override _llmType(): string {
    return "minimax";
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const result = await super._generate(messages, options, runManager);

    if (this.stripThinking) {
      for (const generation of result.generations) {
        const msg = generation.message;
        if (typeof msg.content === "string" && msg.content.includes("<think>")) {
          const strippedContent = stripThinkTags(msg.content);
          generation.message = new AIMessage({
            ...msg,
            content: strippedContent,
          } as BaseMessageFields);
          generation.text = strippedContent;
        }
      }
    }

    return result;
  }
}

export { MINIMAX_MODELS, MINIMAX_BASE_URL, clampTemperature, stripThinkTags };
export type { MiniMaxModel };
