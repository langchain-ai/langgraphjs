import { LanguageModelLike } from "@langchain/core/language_models/base";
import {
  AIMessage,
  AIMessageFields,
  BaseMessage,
  BaseMessageLike,
  isAIMessage,
  isAIMessageChunk,
  isBaseMessage,
  isBaseMessageChunk,
  MessageContent,
  SystemMessage,
} from "@langchain/core/messages";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";

const NAME_PATTERN = /<name>(.*?)<\/name>/s;
const CONTENT_PATTERN = /<content>(.*?)<\/content>/s;

export type AgentNameMode = "inline" | "system-prompt";

/**
 * Attach formatted agent names to the messages passed to and from a language model.
 *
 * This is useful for making a message history with multiple agents more coherent.
 *
 * NOTE: agent name is consumed from the message.name field.
 * If you're using an agent built with createReactAgent, name is automatically set.
 * If you're building a custom agent, make sure to set the name on the AI message returned by the LLM.
 *
 * @deprecated migrated to `langchain` package.
 *
 * @param message - Message to add agent name formatting to
 * @returns Message with agent name formatting
 *
 * @internal
 */
export function _addInlineAgentName<T extends BaseMessageLike>(
  message: T
): T | AIMessage {
  const isAI =
    isBaseMessage(message) &&
    (isAIMessage(message) ||
      (isBaseMessageChunk(message) && isAIMessageChunk(message)));

  if (!isAI || !message.name) {
    return message;
  }

  const { name } = message;

  if (typeof message.content === "string") {
    const fields = (
      Object.keys(message.lc_kwargs ?? {}).length > 0
        ? message.lc_kwargs
        : message
    ) as AIMessageFields;

    return new AIMessage({
      ...fields,
      content: `<name>${name}</name><content>${message.content}</content>`,
      name: undefined,
    });
  }

  const updatedContent = [];
  let textBlockCount = 0;

  for (const contentBlock of message.content) {
    if (typeof contentBlock === "string") {
      textBlockCount += 1;
      updatedContent.push(
        `<name>${name}</name><content>${contentBlock}</content>`
      );
    } else if (
      typeof contentBlock === "object" &&
      "type" in contentBlock &&
      contentBlock.type === "text"
    ) {
      textBlockCount += 1;
      updatedContent.push({
        ...contentBlock,
        text: `<name>${name}</name><content>${contentBlock.text}</content>`,
      });
    } else {
      updatedContent.push(contentBlock);
    }
  }

  if (!textBlockCount) {
    updatedContent.unshift({
      type: "text",
      text: `<name>${name}</name><content></content>`,
    });
  }
  return new AIMessage({
    ...message.lc_kwargs,
    content: updatedContent as MessageContent,
    name: undefined,
  });
}

/**
 * Modify the system message to instruct the model to format its output with agent name XML tags.
 *
 * Unlike `_addInlineAgentName`, this function does NOT modify past AIMessages.
 * Instead, it appends an instruction to the system prompt (or creates one if absent)
 * telling the model to generate its own output in the format:
 * `<name>agentName</name><content>response</content>`
 *
 * This is safe to use with providers that disallow editing message history
 * (e.g. OpenAI Responses API, Anthropic thinking blocks).
 *
 * @param messages - The full message array passed to the model
 * @param agentName - The name of the current agent
 * @returns Updated message array with system prompt instruction injected
 */
export function _addSystemPromptAgentName(
  messages: BaseMessageLike[],
  agentName: string
): BaseMessageLike[] {
  const instruction =
    `\n\nIMPORTANT: Your name is "${agentName}". ` +
    `Always format your response using these XML tags:\n` +
    `<name>${agentName}</name><content>your response here</content>`;

  const firstMsg = messages[0];
  const isSystemMsg =
    isBaseMessage(firstMsg) && firstMsg._getType() === "system";

  if (isSystemMsg && typeof firstMsg.content === "string") {
    return [
      new SystemMessage(firstMsg.content + instruction),
      ...messages.slice(1),
    ];
  }

  // No (string-content) system message found — prepend a new one
  return [new SystemMessage(instruction.trimStart()), ...messages];
}

/**
 * Remove explicit name and content XML tags from the AI message content.
 *
 * @deprecated migrated to `langchain` package.
 *
 * Examples:
 *
 * @example
 * ```typescript
 * removeInlineAgentName(new AIMessage({ content: "<name>assistant</name><content>Hello</content>", name: "assistant" }))
 * // AIMessage with content: "Hello"
 *
 * removeInlineAgentName(new AIMessage({ content: [{type: "text", text: "<name>assistant</name><content>Hello</content>"}], name: "assistant" }))
 * // AIMessage with content: [{type: "text", text: "Hello"}]
 * ```
 *
 * @internal
 */
export function _removeInlineAgentName<T extends BaseMessage>(message: T): T {
  if (!isAIMessage(message) || !message.content) {
    return message;
  }

  let updatedContent: MessageContent = [];
  let updatedName: string | undefined;

  if (Array.isArray(message.content)) {
    updatedContent = message.content
      .filter((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          const nameMatch = block.text.match(NAME_PATTERN);
          const contentMatch = block.text.match(CONTENT_PATTERN);
          // don't include empty content blocks that were added because there was no text block to modify
          if (nameMatch && (!contentMatch || contentMatch[1] === "")) {
            // capture name from text block
            // eslint-disable-next-line prefer-destructuring
            updatedName = nameMatch[1];
            return false;
          }
          return true;
        }
        return true;
      })
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          const nameMatch = block.text.match(NAME_PATTERN);
          const contentMatch = block.text.match(CONTENT_PATTERN);

          if (!nameMatch || !contentMatch) {
            return block;
          }

          // capture name from text block
          // eslint-disable-next-line prefer-destructuring
          updatedName = nameMatch[1];

          return {
            ...block,
            text: contentMatch[1],
          };
        }
        return block;
      });
  } else {
    const content = message.content as string;
    const nameMatch = content.match(NAME_PATTERN);
    const contentMatch = content.match(CONTENT_PATTERN);

    if (!nameMatch || !contentMatch) {
      return message;
    }

    // eslint-disable-next-line prefer-destructuring
    updatedName = nameMatch[1];
    // eslint-disable-next-line prefer-destructuring
    updatedContent = contentMatch[1];
  }

  return new AIMessage({
    ...(Object.keys(message.lc_kwargs ?? {}).length > 0
      ? message.lc_kwargs
      : message),
    content: updatedContent,
    name: updatedName,
  }) as T;
}

/**
 * Attach formatted agent names to the messages passed to and from a language model.
 *
 * This is useful for making a message history with multiple agents more coherent.
 *
 * * @deprecated migrated to `langchain` package.
 *
 * NOTE: agent name is consumed from the message.name field.
 * If you're using an agent built with createReactAgent, name is automatically set.
 * If you're building a custom agent, make sure to set the name on the AI message returned by the LLM.
 *
 * @param model - Language model to add agent name formatting to
 * @param agentNameMode - How to expose the agent name to the LLM
 *   - "inline": Add the agent name directly into the content field of the AI message using XML-style tags.
 *     Example: "How can I help you" -> "<name>agent_name</name><content>How can I help you?</content>".
 *     NOTE: This mutates past AIMessage history and will break with providers that disallow it
 *     (e.g. OpenAI Responses API, Anthropic thinking blocks). Use "system-prompt" in those cases.
 *   - "system-prompt": Inject an instruction into the system prompt telling the model to format
 *     its own output with XML tags. Does NOT modify past messages. Requires `agentName` to be set.
 * @param agentName - The name of the current agent. Required when `agentNameMode` is "system-prompt".
 */
export function withAgentName(
  model: LanguageModelLike,
  agentNameMode: AgentNameMode,
  agentName?: string
): LanguageModelLike {
  if (agentNameMode === "inline") {
    function processInputMessages(
      messages: BaseMessageLike[]
    ): BaseMessageLike[] {
      return messages.map(_addInlineAgentName);
    }

    return RunnableSequence.from([
      RunnableLambda.from(processInputMessages),
      model,
      RunnableLambda.from(_removeInlineAgentName),
    ]);
  } else if (agentNameMode === "system-prompt") {
    if (!agentName) {
      throw new Error(
        `"system-prompt" agent name mode requires an "agentName" to be provided to withAgentName().`
      );
    }
    const resolvedAgentName = agentName;
    return RunnableSequence.from([
      RunnableLambda.from((messages: BaseMessageLike[]) =>
        _addSystemPromptAgentName(messages, resolvedAgentName)
      ),
      model,
      RunnableLambda.from(_removeInlineAgentName),
    ]);
  } else {
    throw new Error(
      `Invalid agent name mode: ${agentNameMode}. Must be one of: "inline", "system-prompt"`
    );
  }
}
