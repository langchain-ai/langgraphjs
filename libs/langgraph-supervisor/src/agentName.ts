import { LanguageModelLike } from "@langchain/core/language_models/base";
import { AIMessage, BaseMessage, isAIMessage } from "@langchain/core/messages";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";

const NAME_PATTERN = /<name>(.*?)<\/name>/s;
const CONTENT_PATTERN = /<content>(.*?)<\/content>/s;

export type AgentNameMode = "inline";

function _isContentBlocksContent(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    typeof content[0] === "object" &&
    content[0] !== null &&
    "type" in content[0]
  );
}

export function addInlineAgentName(message: BaseMessage): BaseMessage {
  /**
   * Add name and content XML tags to the message content.
   *
   * Examples:
   *
   * ```typescript
   * addInlineAgentName(new AIMessage({ content: "Hello", name: "assistant" }))
   * // AIMessage with content: "<name>assistant</name><content>Hello</content>"
   *
   * addInlineAgentName(new AIMessage({ content: [{type: "text", text: "Hello"}], name: "assistant" }))
   * // AIMessage with content: [{type: "text", text: "<name>assistant</name><content>Hello</content>"}]
   * ```
   */
  if (!isAIMessage(message) || !message.name) {
    return message;
  }

  const formattedMessage = new AIMessage({
    ...message,
  });

  if (_isContentBlocksContent(formattedMessage.content)) {
    const content = formattedMessage.content as Array<{
      type: string;
      text: string;
    }>;
    const textBlocks = content.filter((block) => block.type === "text");
    const nonTextBlocks = content.filter((block) => block.type !== "text");

    const textContent = textBlocks.length > 0 ? textBlocks[0].text : "";
    const formattedContent = `<name>${message.name}</name><content>${textContent}</content>`;

    formattedMessage.content = [
      { type: "text", text: formattedContent },
      ...nonTextBlocks,
    ];
  } else {
    formattedMessage.content = `<name>${message.name}</name><content>${formattedMessage.content}</content>`;
  }

  return formattedMessage;
}

export function removeInlineAgentName(message: BaseMessage): BaseMessage {
  /**
   * Remove explicit name and content XML tags from the AI message content.
   *
   * Examples:
   *
   * ```typescript
   * removeInlineAgentName(new AIMessage({ content: "<name>assistant</name><content>Hello</content>", name: "assistant" }))
   * // AIMessage with content: "Hello"
   *
   * removeInlineAgentName(new AIMessage({ content: [{type: "text", text: "<name>assistant</name><content>Hello</content>"}], name: "assistant" }))
   * // AIMessage with content: [{type: "text", text: "Hello"}]
   * ```
   */
  if (!isAIMessage(message) || !message.content) {
    return message;
  }

  const isContentBlocksContent = _isContentBlocksContent(message.content);
  let content: string;

  if (isContentBlocksContent) {
    const contentArr = message.content as Array<{ type: string; text: string }>;
    const textBlocks = contentArr.filter((block) => block.type === "text");

    if (textBlocks.length === 0) {
      return message;
    }

    content = textBlocks[0].text;
  } else {
    content = message.content as string;
  }

  const nameMatch = content.match(NAME_PATTERN);
  const contentMatch = content.match(CONTENT_PATTERN);

  if (!nameMatch || !contentMatch) {
    return message;
  }

  const parsedContent = contentMatch[1];

  const parsedMessage = new AIMessage({
    ...message,
  });

  if (isContentBlocksContent) {
    const contentArr = message.content as Array<{ type: string; text: string }>;
    let contentBlocks = contentArr.filter((block) => block.type !== "text");

    if (parsedContent) {
      contentBlocks = [{ type: "text", text: parsedContent }, ...contentBlocks];
    }

    parsedMessage.content = contentBlocks;
  } else {
    parsedMessage.content = parsedContent;
  }

  return parsedMessage;
}

/**
 * Attach formatted agent names to the messages passed to and from a language model.
 *
 * This is useful for making a message history with multiple agents more coherent.
 *
 * NOTE: agent name is consumed from the message.name field.
 * If you're using an agent built with createReactAgent, name is automatically set.
 * If you're building a custom agent, make sure to set the name on the AI message returned by the LLM.
 *
 * @param model - Language model to add agent name formatting to
 * @param agentNameMode - How to expose the agent name to the LLM
 *   - "inline": Add the agent name directly into the content field of the AI message using XML-style tags.
 *     Example: "How can I help you" -> "<name>agent_name</name><content>How can I help you?</content>".
 */
export function withAgentName(
  model: LanguageModelLike,
  agentNameMode: AgentNameMode
): LanguageModelLike {
  let processInputMessage: (message: BaseMessage) => BaseMessage;
  let processOutputMessage: (message: BaseMessage) => BaseMessage;

  if (agentNameMode === "inline") {
    processInputMessage = addInlineAgentName;
    processOutputMessage = removeInlineAgentName;
  } else {
    throw new Error(
      `Invalid agent name mode: ${agentNameMode}. Needs to be one of: "inline"`
    );
  }

  function processInputMessages(messages: BaseMessage[]): BaseMessage[] {
    return messages.map(processInputMessage);
  }

  return RunnableSequence.from([
    RunnableLambda.from(processInputMessages),
    model,
    RunnableLambda.from(processOutputMessage),
  ]);
}
