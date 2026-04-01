import { useCallback, useEffect, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { Activity, Clock3, Radio, SatelliteDish } from "lucide-react";
import type { Message } from "@langchain/langgraph-sdk";
import { useThreadStream } from "@langchain/react";

import { LoadingIndicator } from "../../components/Loading";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { EmptyState } from "../../components/States";
import { registerExample } from "../registry";

function useThreadIdParam() {
  const [threadId, setThreadId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("threadId");
  });

  const updateThreadId = useCallback((newThreadId: string | null) => {
    setThreadId(newThreadId);

    const url = new URL(window.location.href);
    if (newThreadId == null) {
      url.searchParams.delete("threadId");
    } else {
      url.searchParams.set("threadId", newThreadId);
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  return [threadId, updateThreadId] as const;
}

const EXTERNAL_MESSAGE =
  "[External producer] This run was started outside stream.submit().";

export function ThreadStreamMechanics() {
  const [threadId, setThreadId] = useThreadIdParam();
  const [isLaunchingExternal, setIsLaunchingExternal] = useState(false);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const { scrollRef, contentRef } = useStickToBottom();

  const stream = useThreadStream({
    assistantId: assistantId ?? undefined,
    apiUrl: "http://localhost:2024",
    threadId: threadId ?? undefined,
    onThreadId: setThreadId,
    reconnectOnMount: true,
    streamMode: "run_modes",
  });

  useEffect(() => {
    let isCancelled = false;

    const createAssistant = async () => {
      try {
        const existing = await stream.client.assistants.search({
          graphId: "thread-stream-mechanics",
          limit: 1,
        });

        const assistant =
          existing[0] ??
          (await stream.client.assistants.create({
            graphId: "thread-stream-mechanics",
            name: "Thread Stream Mechanics",
          }));

        if (!isCancelled) {
          setAssistantId(assistant.assistant_id);
        }
      } catch (error) {
        console.error("Failed to resolve assistant for demo:", error);
      }
    };

    void createAssistant();

    return () => {
      isCancelled = true;
    };
  }, [stream.client]);

  useEffect(() => {
    const error = stream.error as unknown;
    if (error == null || !stream.threadId) return;

    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : String(error);
    if (message.includes("404") || message.includes("Thread not found")) {
      stream.switchThread(null);
    }
  }, [stream]);

  const submit = useCallback(
    (content: string) => {
      if (!assistantId) return;

      void stream.submit({
        messages: [{ type: "human", content }],
      });
    },
    [assistantId, stream]
  );

  const ensureThreadId = useCallback(async () => {
    if (stream.threadId) return stream.threadId;

    const created = await stream.client.threads.create();
    stream.switchThread(created.thread_id);
    return created.thread_id;
  }, [stream]);

  const launchExternalRun = useCallback(async () => {
    setIsLaunchingExternal(true);
    try {
      if (!assistantId) return;

      const usableThreadId = await ensureThreadId();
      await stream.client.runs.create(
        usableThreadId,
        assistantId,
        {
          input: {
            messages: [{ type: "human", content: EXTERNAL_MESSAGE }],
          },
          multitaskStrategy: "enqueue",
          streamResumable: true,
        }
      );
      await stream.refresh();
    } finally {
      setIsLaunchingExternal(false);
    }
  }, [assistantId, ensureThreadId, stream]);

  const clearThread = useCallback(() => {
    stream.switchThread(null);
  }, [stream]);

  const hasMessages = stream.messages.length > 0;

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-neutral-800 px-8 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs text-neutral-300">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1">
            <SatelliteDish className="h-3.5 w-3.5 text-brand-accent" />
            Thread stream
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Radio
              className={`h-3.5 w-3.5 ${
                stream.isConnected ? "text-green-400" : "text-neutral-500"
              }`}
            />
            {stream.isConnected ? "connected" : "disconnected"}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Activity
              className={`h-3.5 w-3.5 ${
                stream.isBusy ? "text-amber-400" : "text-neutral-500"
              }`}
            />
            {stream.isBusy ? "busy" : "idle"}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">
            running {stream.runningRuns.length}
          </span>
          <span className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">
            pending {stream.pendingRuns.length}
          </span>
          <span className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">
            queued {stream.queue.size}
          </span>
        </div>
      </div>

      <div className="border-b border-neutral-800 px-8 py-3 flex items-center gap-2 flex-wrap">
        <button
          onClick={launchExternalRun}
          disabled={isLaunchingExternal || !assistantId}
          className="rounded-lg border border-brand-dark/60 bg-brand-dark/20 px-3 py-1.5 text-xs text-brand-light hover:bg-brand-dark/35 disabled:opacity-60"
        >
          {isLaunchingExternal ? "Launching..." : "Launch external run"}
        </button>
        <button
          onClick={() => void stream.refresh()}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          Refresh state
        </button>
        <button
          onClick={() => void stream.queue.clear()}
          disabled={stream.queue.size === 0}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
        >
          Clear queue
        </button>
        <button
          onClick={clearThread}
          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          New thread
        </button>

        <div className="ml-auto text-xs text-neutral-500 font-mono truncate max-w-80">
          {stream.threadId ? `thread: ${stream.threadId}` : "thread: (new)"}
        </div>
      </div>

      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Clock3}
              title="Thread Stream Mechanics"
              description="Send a message, then launch an external run while the thread is busy. useThreadStream keeps one live view of all pending/running runs on the thread."
              suggestions={[
                "Hello from submit()",
                "Queue two messages quickly",
                "Launch external run while active",
              ]}
              onSuggestionClick={submit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message: Message, idx: number) => (
                <MessageBubble key={message.id ?? idx} message={message} />
              ))}
              {stream.isBusy && <LoadingIndicator />}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="mx-auto w-full max-w-2xl px-4 pb-3 text-xs text-red-300">
          <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2">
            {stream.error instanceof Error
              ? stream.error.message
              : String(stream.error)}
          </div>
        </div>
      )}

      <MessageInput
        disabled={isLaunchingExternal || !assistantId}
        placeholder="Send message via useThreadStream.submit(...)"
        onSubmit={submit}
      />
    </div>
  );
}

registerExample({
  id: "thread-stream-mechanics",
  title: "Thread Stream Mechanics",
  description:
    "Thread-level streaming with local submit + external run enqueue",
  category: "advanced",
  icon: "chat",
  ready: true,
  component: ThreadStreamMechanics,
});

export default ThreadStreamMechanics;
