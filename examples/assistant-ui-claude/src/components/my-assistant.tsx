"use client";

import { useCallback, useMemo } from "react";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  SimpleImageAttachmentAdapter,
  type AppendMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useStream } from "@langchain/react";

import { Claude } from "./claude";
import {
  toLangGraphMessageContent,
  toThreadMessages,
} from "../lib/message-utils";
import { useThreadIdParam } from "../lib/thread-id";

const attachmentAdapter = new CompositeAttachmentAdapter([
  new SimpleImageAttachmentAdapter(),
]);
const apiUrl =
  import.meta.env.VITE_LANGGRAPH_API_URL ??
  `${window.location.origin}/api/langgraph`;

export function MyAssistant() {
  const [threadId, onThreadId] = useThreadIdParam();
  const stream = useStream({
    apiUrl,
    assistantId: import.meta.env.VITE_LANGGRAPH_ASSISTANT_ID ?? "claude",
    onThreadId,
    reconnectOnMount: true,
    fetchStateHistory: true,
    threadId,
  });

  const messages = useMemo(
    () => toThreadMessages(stream.messages),
    [stream.messages],
  );

  const submitPrompt = useCallback(
    async (prompt: string) => {
      await stream.submit(
        { messages: [{ content: prompt, type: "human" }] },
        {
          config: {
            recursion_limit: 50,
          },
        },
      );
    },
    [stream],
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const content = toLangGraphMessageContent(message.content);
      if (!content) return;

      await stream.submit(
        { messages: [{ content, type: "human" }] },
        {
          config: {
            recursion_limit: 50,
          },
        },
      );
    },
    [stream],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    adapters: {
      attachments: attachmentAdapter,
    },
    convertMessage: (message) => message,
    messages,
    onCancel: async () => {
      stream.stop();
    },
    onNew,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Claude
        error={stream.error}
        isLoading={stream.isLoading}
        onCancel={() => {
          stream.stop();
        }}
        onSuggestionClick={submitPrompt}
      />
    </AssistantRuntimeProvider>
  );
}
