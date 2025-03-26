import { AIMessageChunk, SystemMessage } from "@langchain/core/messages";
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
    response = await model.invoke([lastMessage]);
  } else {
    const prompt = _promptToSysMessage(configuration.prompt);
    response = await model.invoke([
      ...(prompt ? [prompt] : []),
      ...state.messages,
    ]);
  }

  return {
    messages: response,
  };
}
