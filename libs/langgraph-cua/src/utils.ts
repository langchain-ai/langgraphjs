import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResponseComputerToolCall } from "openai/resources/responses/responses";
import {
  ScrapybaraClient,
  UbuntuInstance,
  BrowserInstance,
  WindowsInstance,
} from "scrapybara";
import { CUAEnvironment, getConfigurationWithDefaults } from "./types.js";

/**
 * Gets the Scrapybara client, using the API key from the graph's configuration object.
 *
 * @param {LangGraphRunnableConfig} config The configuration for the runnable. This will include the Scrapybara API key.
 * @returns {ScrapybaraClient} The Scrapybara client.
 */
export function getScrapybaraClient(
  config: LangGraphRunnableConfig
): ScrapybaraClient {
  const { scrapybaraApiKey } = getConfigurationWithDefaults(config);
  if (!scrapybaraApiKey) {
    throw new Error(
      "Scrapybara API key not provided. Please provide one in the configurable fields, or set it as an environment variable (SCRAPYBARA_API_KEY)"
    );
  }
  const client = new ScrapybaraClient({
    apiKey: scrapybaraApiKey,
  });
  return client;
}

type InitOrLoadInputs = {
  instanceId: string | undefined;
  environment: CUAEnvironment;
};

/**
 * Initializes or loads an instance based on the inputs provided.
 *
 * @param {InitOrLoadInputs} inputs The instanceId and environment to use in the virtual machine.
 * @param {LangGraphRunnableConfig} config The configuration for the runnable.
 * @returns {Promise<UbuntuInstance | BrowserInstance | WindowsInstance>} The initialized or loaded instance.
 */
export async function initOrLoad(
  inputs: InitOrLoadInputs,
  config: LangGraphRunnableConfig
): Promise<UbuntuInstance | BrowserInstance | WindowsInstance> {
  const { instanceId, environment } = inputs;
  const client = getScrapybaraClient(config);

  if (instanceId) {
    return await client.get(instanceId);
  }

  if (environment === "ubuntu") {
    return await client.startUbuntu();
  } else if (environment === "windows") {
    return await client.startWindows();
  } else if (environment === "web") {
    return await client.startBrowser();
  }

  throw new Error(
    `Invalid environment. Must be one of 'web', 'ubuntu', or 'windows'. Received: ${environment}`
  );
}

/**
 * Checks if the given tool outputs are a computer call.
 *
 * @param {unknown} toolOutputs The tool outputs to check.
 * @returns {boolean} True if the tool outputs are a computer call, false otherwise.
 */
export function isComputerToolCall(
  toolOutputs: unknown
): toolOutputs is ResponseComputerToolCall[] {
  if (!toolOutputs || !Array.isArray(toolOutputs)) {
    return false;
  }
  return toolOutputs.every((output) => output.type === "computer_call");
}
