import { Suspense, useState } from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { Client } from "@langchain/langgraph-sdk/client";
import { useSuspenseStream } from "../../index.js";

interface Props {
  apiUrl: string;
}

function SuspenseChat({
  apiUrl,
  threadId,
  onThreadId,
}: {
  apiUrl: string;
  threadId: string | null;
  onThreadId: (id: string) => void;
}) {
  const thread = useSuspenseStream<{ messages: Message[] }>({
    assistantId: "agent",
    apiUrl,
    threadId: threadId ?? undefined,
    onThreadId,
  });

  return (
    <div>
      <div data-testid="messages">
        {thread.messages.map((msg, i) => (
          <div key={msg.id ?? i} data-testid={`message-${i}`}>
            {typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content)}
          </div>
        ))}
      </div>
      <div data-testid="streaming">
        {thread.isStreaming ? "Streaming..." : "Not streaming"}
      </div>
      <div data-testid="message-count">{thread.messages.length}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [{ content: "Hello", type: "human" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}

export function SuspenseWithThreadId({ apiUrl }: Props) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [showThreadId, setShowThreadId] = useState(false);

  const createThread = async () => {
    const client = new Client({ apiUrl });
    const thread = await client.threads.create();
    setThreadId(thread.thread_id);
    setShowThreadId(true);
  };

  return (
    <div>
      <div data-testid="thread-id">{threadId ?? "none"}</div>
      <button data-testid="create-thread" onClick={() => void createThread()}>
        Create Thread
      </button>
      <Suspense
        fallback={<div data-testid="suspense-fallback">Loading thread...</div>}
      >
        <SuspenseChat
          apiUrl={apiUrl}
          threadId={showThreadId ? threadId : null}
          onThreadId={setThreadId}
        />
      </Suspense>
    </div>
  );
}
