import {
  AIMessageChunk,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {
  CUAEnvironment,
  CUAState,
  getConfigurationWithDefaults,
} from "../types.js";
import { isComputerCallToolMessage } from "../utils.js";

const _getOpenAIEnvFromStateEnv = (env: CUAEnvironment) => {
  switch (env) {
    case "web":
      return "browser";
    case "ubuntu":
      return "ubuntu";
    case "windows":
      return "windows";
    default:
      throw new Error(`Invalid environment: ${env}`);
  }
};

/**
 * Converts an image URL to a base64 string. This is because OpenAI's
 * computer use API does not support external image URLs, so all requests
 * must be base64.
 *
 * @param imageUrl - The URL of the image to convert.
 * @returns The base64 string representation of the image.
 */
async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:image/png;base64,${base64}`;
}

/**
 * Conditionally updates the content of a tool message if it is a computer call output.
 * If the message is a tool message with a computer call output type and a URL content,
 * it converts the URL to a base64 string.
 *
 * @param message - The message to update.
 * @returns The updated message.
 */
async function conditionallyUpdateToolMessageContent(
  message: BaseMessage
): Promise<BaseMessage> {
  if (
    message.getType() === "tool" &&
    message.additional_kwargs?.type === "computer_call_output" &&
    typeof message.content === "string" &&
    isUrl(message.content)
  ) {
    return new ToolMessage({
      ...(message as ToolMessage),
      content: await imageUrlToBase64(message.content),
    });
  }

  return message;
}

const conditionallyUpdateToolMessageContentRunnable = RunnableLambda.from(
  conditionallyUpdateToolMessageContent
).withConfig({ runName: "conditionally-update-tool-message-content" });

function isUrl(value: string): boolean {
  try {
    return !!new URL(value);
  } catch (e) {
    return false;
  }
}

// Scrapybara does not allow for configuring this. Must use a hardcoded value.
const DEFAULT_DISPLAY_WIDTH = 1024;
const DEFAULT_DISPLAY_HEIGHT = 768;

const _promptToSysMessage = (prompt: string | SystemMessage | undefined) => {
  if (typeof prompt === "string") {
    return { role: "system", content: prompt };
  }
  return prompt;
};

/**
 * Invokes the computer preview model with the given messages.
 *
 * @param {CUAState} state - The current state of the thread.
 * @param {LangGraphRunnableConfig} config - The configuration to use.
 * @returns {Promise<CUAUpdate>} - The updated state with the model's response.
 */
export async function callModel(
  state: CUAState,
  config: LangGraphRunnableConfig
) {
  const configuration = getConfigurationWithDefaults(config);

  const lastMessage = state.messages[state.messages.length - 1];
  let previousResponseId: string | undefined;
  const isLastMessageComputerCallOutput =
    isComputerCallToolMessage(lastMessage);
  if (isLastMessageComputerCallOutput && !configuration.zdrEnabled) {
    // Assume if the last message is a tool message, the second to last will be an AI message
    const secondToLast = state.messages[state.messages.length - 2];
    previousResponseId = secondToLast.response_metadata.id;
  }

  const model = new ChatOpenAI({
    model: "computer-use-preview",
    useResponsesApi: true,
  })
    .bindTools([
      {
        type: "computer_use_preview",
        display_width: DEFAULT_DISPLAY_WIDTH,
        display_height: DEFAULT_DISPLAY_HEIGHT,
        environment: _getOpenAIEnvFromStateEnv(configuration.environment),
      },
    ])
    .bind({
      truncation: "auto",
      previous_response_id: previousResponseId,
    });

  /** @inline */
  type AIMessageChunkOpenAI = AIMessageChunk & {
    additional_kwargs: {
      tool_outputs?: {
        call_id: string;
        action: { type: string; display_width: number; display_height: number };
      }[];
    };
  };

  let response: AIMessageChunkOpenAI;
  if (isLastMessageComputerCallOutput && !configuration.zdrEnabled) {
    const formattedMessage =
      await conditionallyUpdateToolMessageContentRunnable.invoke(lastMessage);
    response = (await model.invoke([formattedMessage])) as AIMessageChunkOpenAI;
  } else {
    const formattedMessagesPromise = state.messages.map((m) =>
      conditionallyUpdateToolMessageContentRunnable.invoke(m)
    );
    const prompt = _promptToSysMessage(configuration.prompt);
    response = (await model.invoke([
      ...(prompt ? [prompt] : []),
      ...(await Promise.all(formattedMessagesPromise)),
    ])) as AIMessageChunkOpenAI;
  }

  return {
    messages: response,
  };
}
