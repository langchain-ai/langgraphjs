import type { BaseMessage } from "@langchain/core/messages";
import { useMessages, type AnyStream } from "@langchain/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import { Shimmer } from "./ai-elements/shimmer";
import { ToolCall } from "./tool-call";

interface RenderedItem {
  id: string;
  kind: "human" | "ai" | "tool-call";
  content?: string;
  reasoning?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolError?: string;
  isStreaming?: boolean;
}

type MessageToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

function getReasoning(message: BaseMessage): string | undefined {
  const block = message.contentBlocks.find((contentBlock) => {
    if (contentBlock.type !== "reasoning") return false;
    return (
      typeof (contentBlock as { reasoning?: unknown }).reasoning === "string"
    );
  });
  return (block as { reasoning?: string } | undefined)?.reasoning;
}

function buildRenderItems(
  messages: BaseMessage[],
  isLoading: boolean,
): RenderedItem[] {
  const items: RenderedItem[] = [];
  const toolResultMap = new Map<string, { output?: unknown; error?: string }>();

  for (const msg of messages) {
    if (msg.type !== "tool") continue;

    const toolMsg = msg as BaseMessage & {
      tool_call_id?: string;
      status?: string;
    };
    if (!toolMsg.tool_call_id) continue;

    const output = parseToolOutput(msg.text);
    toolResultMap.set(toolMsg.tool_call_id, {
      output,
      error: toolMsg.status === "error" ? String(output) : undefined,
    });
  }

  console.log(3, messages)

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgType = msg.type;
    const isLastMsg = i === messages.length - 1;

    if (msgType === "human") {
      items.push({ id: `human-${i}`, kind: "human", content: msg.text });
      continue;
    }

    if (msgType === "ai") {
      const aiMsg = msg as BaseMessage & {
        tool_calls?: MessageToolCall[];
      };

      const reasoning = getReasoning(msg);
      const textContent = msg.text;

      // Reasoning is still streaming when the last message is loading and text hasn't arrived yet.
      const reasoningStreaming = isLastMsg && isLoading && !textContent;

      if (reasoning) {
        items.push({
          id: `reasoning-${i}`,
          kind: "ai",
          reasoning,
          content: textContent || undefined,
          isStreaming: reasoningStreaming,
        });
      } else if (textContent) {
        items.push({ id: `ai-${i}`, kind: "ai", content: textContent });
      }

      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        for (const tc of aiMsg.tool_calls) {
          const result = tc.id ? toolResultMap.get(tc.id) : undefined;
          items.push({
            id: `tc-${tc.id ?? i}`,
            kind: "tool-call",
            toolName: tc.name,
            toolInput: tc.args,
            toolOutput: result?.output,
            toolError: result?.error,
            isStreaming: isLastMsg && isLoading && !result,
          });
        }
      }

      continue;
    }
  }

  return items;
}

function parseToolOutput(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface MessageListProps {
  stream: AnyStream;
  onCopyLastMessage: () => void;
}

export function MessageList({
  stream,
  onCopyLastMessage,
}: MessageListProps) {
  const [copied, setCopied] = useState(false);
  const messages = useMessages(stream);
  const isLoading = stream.isLoading;
  const items = useMemo(
    () => buildRenderItems(messages, isLoading),
    [messages, isLoading],
  );
  const lastAiIndex = [...items].reverse().findIndex((it) => it.kind === "ai");
  const lastAiItemIndex =
    lastAiIndex >= 0 ? items.length - 1 - lastAiIndex : -1;
  const showShimmer =
    isLoading && items.length > 0 && items[items.length - 1].kind === "human";

  function handleCopy() {
    onCopyLastMessage();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {items.map((item, idx) => {
          if (item.kind === "human") {
            return (
              <Message key={item.id} from="user">
                <MessageContent>{item.content}</MessageContent>
              </Message>
            );
          }

          if (item.kind === "tool-call") {
            return (
              <ToolCall
                key={item.id}
                toolName={item.toolName ?? "unknown"}
                input={item.toolInput ?? {}}
                output={item.toolOutput}
                error={item.toolError}
                isStreaming={item.isStreaming}
              />
            );
          }

          const isLastAi = idx === lastAiItemIndex;

          return (
            <div key={item.id} className="flex flex-col gap-1">
              {item.reasoning && (
                <Reasoning isStreaming={item.isStreaming} className="w-full">
                  <ReasoningTrigger />
                  <ReasoningContent>{item.reasoning}</ReasoningContent>
                </Reasoning>
              )}
              {item.content && (
                <Message from="assistant">
                  <MessageContent>
                    <MessageResponse>{item.content}</MessageResponse>
                  </MessageContent>
                </Message>
              )}
              {isLastAi && !isLoading && (
                <MessageActions>
                  <MessageAction
                    label={copied ? "Copied" : "Copy"}
                    tooltip={copied ? "Copied!" : "Copy message"}
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <CheckIcon className="size-3 text-green-500" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </MessageAction>
                </MessageActions>
              )}
            </div>
          );
        })}

        {showShimmer && (
          <div className="px-1">
            <Shimmer as="span" className="text-sm">
              Thinking...
            </Shimmer>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
