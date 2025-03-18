import { AIMessageChunk } from "@langchain/core/messages";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import {
  CUAEnvironment,
  CUAState,
  CUAUpdate,
  getConfigurationWithDefaults,
} from "../types.js";

const getOpenAIEnvFromStateEnv = (env: CUAEnvironment) => {
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
 * Invokes the computer preview model with the given messages.
 *
 * @param {CUAState} state - The current state of the thread.
 * @param {LangGraphRunnableConfig} config - The configuration for the runnable.
 * @returns {Promise<CUAUpdate>} - The updated state with the model's response.
 */
export async function callModel(
  state: CUAState,
  config: LangGraphRunnableConfig
): Promise<CUAUpdate> {
  const { displayWidth, displayHeight } = getConfigurationWithDefaults(config);

  const lastMessage = state.messages[state.messages.length - 1];
  let previousResponseId: string | undefined;
  if (lastMessage?.id && lastMessage.getType() === "ai") {
    previousResponseId = lastMessage.id;
  }

  const model = new ChatOpenAI({
    model: "computer-use-preview",
    useResponsesApi: true,
  })
    .bindTools([
      {
        type: "computer-preview",
        display_width: displayWidth,
        display_height: displayHeight,
        environment: getOpenAIEnvFromStateEnv(state.environment),
      },
    ])
    .bind({
      truncation: "auto",
      previous_response_id: previousResponseId,
    });

  let response: AIMessageChunk;
  if (state.computerCallOutput) {
    // TODO: How to pass back computer call outputs?
    response = await model.invoke([
      {
        role: "tool",
        content: [state.computerCallOutput],
      },
    ]);
  } else {
    response = await model.invoke(state.messages);
  }

  return {
    messages: response,
  };
}
