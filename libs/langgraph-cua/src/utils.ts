import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResponseComputerToolCall } from "openai/resources/responses/responses";
import {
  ScrapybaraClient,
  UbuntuInstance,
  BrowserInstance,
  WindowsInstance,
} from "scrapybara";
import { getConfigurationWithDefaults } from "./types.js";

// Copied from the OpenAI example repository
// https://github.com/openai/openai-cua-sample-app/blob/eb2d58ba77ffd3206d3346d6357093647d29d99c/utils.py#L13
// const BLOCKED_DOMAINS = [
//     "maliciousbook.com",
//     "evilvideos.com",
//     "darkwebforum.com",
//     "shadytok.com",
//     "suspiciouspins.com",
//     "ilanbigio.com",
// ]

/**
 * Gets the Scrapybara client, using the API key from the graph's configuration object.
 *
 * @param {string} apiKey The API key for Scrapybara.
 * @returns {ScrapybaraClient} The Scrapybara client.
 */
export function getScrapybaraClient(apiKey: string): ScrapybaraClient {
  if (!apiKey) {
    throw new Error(
      "Scrapybara API key not provided. Please provide one in the configurable fields, or set it as an environment variable (SCRAPYBARA_API_KEY)"
    );
  }
  const client = new ScrapybaraClient({
    apiKey,
  });
  return client;
}

/**
 * Gets an instance from Scrapybara.
 *
 * @param {string} id The ID of the instance to get.
 * @param {LangGraphRunnableConfig} config The configuration for the runnable.
 * @returns {Promise<UbuntuInstance | BrowserInstance | WindowsInstance>} The instance.
 */
export async function getInstance(
  id: string,
  config: LangGraphRunnableConfig
): Promise<UbuntuInstance | BrowserInstance | WindowsInstance> {
  const { scrapybaraApiKey } = getConfigurationWithDefaults(config);
  if (!scrapybaraApiKey) {
    throw new Error(
      "Scrapybara API key not provided. Please provide one in the configurable fields, or set it as an environment variable (SCRAPYBARA_API_KEY)"
    );
  }
  const client = getScrapybaraClient(scrapybaraApiKey);
  return await client.get(id);
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
  return (
    toolOutputs.filter((output) => output.type === "computer_call").length > 0
  );
}

/**
 * Stops an instance by its ID.
 *
 * @param {string} id The ID of the instance to stop.
 * @param {ScrapybaraClient} client Optional client to use for stopping the instance.
 * @returns {Promise<void>} A promise that resolves when the instance is stopped.
 */
export async function stopInstance(
  id: string,
  client?: ScrapybaraClient
): Promise<void> {
  let client_ = client;
  if (!client_) {
    client_ = getScrapybaraClient(process.env.SCRAPYBARA_API_KEY!);
  }
  const instance = await client_.get(id);
  await instance.stop();
}
