import { AIMessageChunk } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { CUAEnvironment, CUAState, CUAUpdate } from "../types.js";

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

// Scrapybara does not allow for configuring this. Must use a hardcoded value.
const DEFAULT_DISPLAY_WIDTH = 1024;
const DEFAULT_DISPLAY_HEIGHT = 768;

/**
 * Invokes the computer preview model with the given messages.
 *
 * @param {CUAState} state - The current state of the thread.
 * @returns {Promise<CUAUpdate>} - The updated state with the model's response.
 */
export async function callModel(state: CUAState): Promise<CUAUpdate> {
  const lastMessage = state.messages[state.messages.length - 1];
  let previousResponseId: string | undefined;
  if (lastMessage.getType() === "tool") {
    // Assume if the last message is a tool message, the second to last will be an AI message
    const secondToLast = state.messages[state.messages.length - 2];
    previousResponseId = secondToLast.id;
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
        environment: getOpenAIEnvFromStateEnv(state.environment),
      },
    ])
    .bind({
      truncation: "auto",
      previous_response_id: previousResponseId,
    });

  let response: AIMessageChunk;
  if (
    lastMessage.getType() === "tool" &&
    "type" in lastMessage.additional_kwargs &&
    lastMessage.additional_kwargs.type === "computer_call_output"
  ) {
    response = await model.invoke([lastMessage]);
  } else {
    response = await model.invoke(state.messages);
  }

  return {
    messages: response,
  };
}
