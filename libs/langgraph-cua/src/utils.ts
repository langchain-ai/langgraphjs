import { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ResponseComputerToolCall } from "openai/resources/responses/responses";
import {
  ScrapybaraClient,
  UbuntuInstance,
  BrowserInstance,
  WindowsInstance,
} from "scrapybara";
import { Hyperbrowser } from "@hyperbrowser/sdk";
import { SessionDetail } from "@hyperbrowser/sdk/types";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { getConfigurationWithDefaults } from "./types.js";

/**
 * Gets the Hyperbrowser client, using the API key from the graph's configuration object.
 *
 * @param {string} apiKey The API key for Hyperbrowser.
 * @returns {HyperbrowserClient} The Hyperbrowser client.
 */
export function getHyperbrowserClient(apiKey: string): Hyperbrowser {
  if (!apiKey) {
    throw new Error(
      "Hyperbrowser API key not provided. Please provide one in the configurable fields, or set it as an environment variable (HYPERBROWSER_API_KEY)"
    );
  }
  const client = new Hyperbrowser({
    apiKey,
  });
  return client;
}

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
export async function getScrapybaraInstance(
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
 * Gets an instance from Hyperbrowser.
 *
 * @param {string} id The ID of the instance to get.
 * @param {LangGraphRunnableConfig} config The configuration for the runnable.
 * @returns {Promise<SessionDetail>} The instance.
 */
export async function getHyperbrowserInstance(
  id: string,
  config: LangGraphRunnableConfig
): Promise<SessionDetail> {
  const { hyperbrowserApiKey } = getConfigurationWithDefaults(config);
  if (!hyperbrowserApiKey) {
    throw new Error(
      "Hyperbrowser API key not provided. Please provide one in the configurable fields, or set it as an environment variable (HYPERBROWSER_API_KEY)"
    );
  }
  const client = getHyperbrowserClient(hyperbrowserApiKey);
  return await client.sessions.get(id);
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
 * Stops a Scrapybara instance by its ID.
 *
 * @param {string} id The ID of the instance to stop.
 * @param {ScrapybaraClient} client Optional client to use for stopping the instance.
 * @returns {Promise<void>} A promise that resolves when the instance is stopped.
 */
export async function stopScrapybaraInstance(
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
 * Stops a Hyperbrowser instance by its ID.
 *
 * @param {string} id The ID of the instance to stop.
 * @param {HyperbrowserClient} client Optional client to use for stopping the instance.
 * @returns {Promise<void>} A promise that resolves when the instance is stopped.
 */
export async function stopHyperbrowserInstance(
  id: string,
  client?: Hyperbrowser
): Promise<void> {
  let client_ = client;
  if (!client_) {
    client_ = getHyperbrowserClient(
      getEnvironmentVariable("HYPERBROWSER_API_KEY") ?? ""
    );
  }
  await client_.sessions.stop(id);
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
