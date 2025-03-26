import { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ResponseComputerToolCall } from "openai/resources/responses/responses";
import {
  ScrapybaraClient,
  UbuntuInstance,
  BrowserInstance,
  WindowsInstance,
} from "scrapybara";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { getConfigurationWithDefaults } from "./types.js";

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
    client_ = getScrapybaraClient(
      getEnvironmentVariable("SCRAPYBARA_API_KEY") ?? ""
    );
  }
  const instance = await client_.get(id);
  await instance.stop();
}

/**
 * Gets the tool outputs from an AIMessage.
 *
 * @param {AIMessage} message The message to get tool outputs from.
 * @returns {ResponseComputerToolCall[] | undefined} The tool outputs from the message, or undefined if there are none.
 */
export function getToolOutputs(
  message: AIMessage
): ResponseComputerToolCall[] | undefined {
  const toolOutputs = message.additional_kwargs?.tool_outputs
    ? message.additional_kwargs?.tool_outputs
    : message.response_metadata?.output;

  if (!toolOutputs || !toolOutputs.length) {
    return undefined;
  }

  return toolOutputs.filter(
    (output: Record<string, unknown>) => output.type === "computer_call"
  );
}

/**
 * Checks if a message is a computer call tool message.
 *
 * @param {BaseMessage} message The message to check.
 * @returns {boolean} True if the message is a computer call tool message, false otherwise.
 */
export function isComputerCallToolMessage(
  message: BaseMessage
): message is ToolMessage {
  return (
    message.getType() === "tool" &&
    "type" in message.additional_kwargs &&
    message.additional_kwargs.type === "computer_call_output"
  );
}
