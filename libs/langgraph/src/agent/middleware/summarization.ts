import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { AgentMiddleware } from "../agent";
import { LanguageModelLike } from "@langchain/core/language_models/base";

interface SummarizationMiddlewareOptions {
  maxTokensBeforeSummary: number;
  model: LanguageModelLike;
  messagesToLeave?: number;
  summarySystemPrompt?: string;
  fakeToolName?: string;
  tokenCounter: (messages: BaseMessage[]) => Promise<number> | number;
}

const DEFAULT_SUMMARY_PROMPT = `<role>
Context Extraction Assistant
</role>

<primary_objective>
Your sole objective in this task is to extract the highest quality/most relevant context from the conversation history below.
</primary_objective>

<objective_information>
You're nearing the total number of input tokens you can accept, so you must extract the highest quality/most relevant pieces of information from your conversation history.
This context will then overwrite the conversation history presented below. Because of this, ensure the context you extract is only the most important information to your overall goal.
</objective_information>

<instructions>
The conversation history below will be replaced with the context you extract in this step. Because of this, you must do your very best to extract and record all of the most important context from the conversation history.
You want to ensure that you don't repeat any actions you've already completed, so the context you extract from the conversation history should be focused on the most important information to your overall goal.
</instructions>

The user will message you with the full message history you'll be extracting context from, to then replace. Carefully read over it all, and think deeply about what information is most important to your overall goal that should be saved:
With all of this in mind, please carefully read over the entire conversation history, and extract the most important and relevant context to replace it so that you can free up space in the conversation history.

Respond ONLY with the extracted context. Do not include any additional information, or text before or after the extracted context.`;

export const summarization: (
  options: SummarizationMiddlewareOptions
) => AgentMiddleware = (options) => {
  const {
    maxTokensBeforeSummary,
    messagesToLeave = 20,
    model,
    fakeToolName = "summarize_convo",
    summarySystemPrompt = DEFAULT_SUMMARY_PROMPT,
    tokenCounter,
  } = options;

  return {
    name: "summarization",

    beforeModel: async (state) => {
      const tokenCount = await tokenCounter(state.messages);

      // If the token count is less than the max tokens before summary, return early
      if (tokenCount < maxTokensBeforeSummary) return {};
      const messagesToSummarize = state.messages.slice(0, -messagesToLeave);

      const summaryOutput = (await model.invoke([
        new SystemMessage(summarySystemPrompt),
        new HumanMessage(
          messagesToSummarize.map((message) => message.text).join("\n")
        ),
      ])) as BaseMessage;

      const summary = summaryOutput.text;

      // Create fake messages to add to history
      const fakeToolCallId = crypto.randomUUID();

      const fakeMessages = [
        new AIMessage({
          content:
            "Looks like I'm running out of tokens. I'm going to summarize the conversation history to free up space.",
          tool_calls: [
            {
              id: fakeToolCallId,
              name: fakeToolName,
              args: {
                reasoning:
                  "I'm running out of tokens. I'm going to summarize all of the messages since my last summary message to free up space.",
              },
            },
          ],
        }),
        new ToolMessage({
          tool_call_id: fakeToolCallId,
          content: summary,
        }),
      ];

      const toDeleteMessages = messagesToSummarize.map(
        (msg) => new RemoveMessage({ id: msg.id! })
      );

      return { messages: [...toDeleteMessages, ...fakeMessages] };
    },
  };
};
