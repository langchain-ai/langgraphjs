import { LangGraphRunnableConfig } from "@langchain/langgraph";
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
  if (
    !config.configurable?.displayWidth ||
    !config.configurable?.displayHeight
  ) {
    throw new Error("displayWidth and displayHeight must be provided");
  }

  const model = new ChatOpenAI({
    model: "computer-use-preview",
    useResponsesApi: true,
  })
    .bindTools([
      {
        type: "computer-preview",
        display_width: config.configurable.displayWidth,
        display_height: config.configurable.displayHeight,
        environment: getOpenAIEnvFromStateEnv(state.environment),
      },
    ])
    .bind({
      truncation: "auto",
    });

  const response = await model.invoke(state.messages);

  return {
    messages: response,
  };
}
