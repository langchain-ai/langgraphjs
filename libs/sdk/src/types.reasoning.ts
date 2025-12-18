/**
 * OpenAI reasoning summary item structure.
 * Used when streaming reasoning tokens from OpenAI models.
 */
export type ReasoningSummaryItem = {
  type: "summary_text";
  text: string;
  index?: number;
};

/**
 * OpenAI reasoning structure in additional_kwargs.
 */
export type OpenAIReasoning = {
  id?: string;
  type: "reasoning";
  summary?: ReasoningSummaryItem[];
};

/**
 * Anthropic thinking content block structure.
 * Used when streaming extended thinking from Claude models.
 */
export type ThinkingContentBlock = {
  type: "thinking";
  thinking: string;
};

/**
 * Represents reasoning/thinking content extracted from an AI message.
 * Supports both OpenAI reasoning and Anthropic extended thinking formats.
 */
export type ReasoningContent = {
  /**
   * Unique identifier for this reasoning block.
   * Uses the reasoning id if available from OpenAI, otherwise generates from message id.
   */
  id: string;

  /**
   * The reasoning/thinking text content.
   */
  content: string;

  /**
   * The source format of the reasoning.
   * - `openai`: From additional_kwargs.reasoning.summary
   * - `anthropic`: From contentBlocks with type "thinking"
   * - `content`: From message.content array with type "thinking"
   */
  source: "openai" | "anthropic" | "content";

  /**
   * Whether this reasoning is still being streamed.
   */
  isStreaming: boolean;
};

/**
 * Reasoning message type for UI rendering.
 * Represents reasoning/thinking content extracted from AI messages.
 * This synthetic message type is inserted into uiMessages to display
 * reasoning content as a separate bubble.
 */
export type ReasoningMessage = {
  type: "reasoning";
  /**
   * The name of the agent that is reasoning.
   */
  name?: string | undefined;
  /**
   * The reasoning/thinking text content.
   */
  content: string;
  /**
   * Unique identifier for this reasoning block.
   */
  id: string;
  /**
   * The ID of the AI message this reasoning belongs to.
   */
  parentMessageId?: string;
  /**
   * The source format of the reasoning.
   * - `openai`: From additional_kwargs.reasoning.summary
   * - `anthropic`: From contentBlocks with type "thinking"
   * - `content`: From message.content array with type "thinking"
   */
  source: "openai" | "anthropic" | "content";
};
