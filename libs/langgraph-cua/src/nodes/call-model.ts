import {
  AIMessageChunk,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {
  CUAEnvironment,
  CUAState,
  CUAUpdate,
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

async function imageUrlToBase64(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  return `data:image/png;base64,${base64}`;
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
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
): Promise<CUAUpdate> {
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

  let response: AIMessageChunk;
  if (isLastMessageComputerCallOutput && !configuration.zdrEnabled) {
    if (
      lastMessage.getType() === "tool" &&
      lastMessage.additional_kwargs?.type === "computer_call_output" &&
      typeof lastMessage.content === "string" &&
      isUrl(lastMessage.content)
    ) {
      response = await model.invoke([
        new ToolMessage({
          ...lastMessage,
          content: await imageUrlToBase64(lastMessage.content),
        }),
      ]);
    } else {
      response = await model.invoke([lastMessage]);
    }
  } else {
    const formattedMessagesPromise = state.messages.map(async (m) => {
      if (
        m.getType() === "tool" &&
        m.additional_kwargs?.type === "computer_call_output" &&
        typeof m.content === "string" &&
        isUrl(m.content)
      ) {
        return new ToolMessage({
          ...(m as ToolMessage),
          content: await imageUrlToBase64(m.content),
        });
      }
      return m;
    });
    const prompt = _promptToSysMessage(configuration.prompt);
    response = await model.invoke([
      ...(prompt ? [prompt] : []),
      ...(await Promise.all(formattedMessagesPromise)),
    ]);
  }

  return {
    messages: response,
  };
}
