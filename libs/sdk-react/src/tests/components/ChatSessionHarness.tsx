import { useEffect, useMemo, useRef, useState } from "react";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";
import {
  createDurableReplayFetch,
  type DurableReplayFetchOptions,
} from "../fixtures/durable-replay-fetch.js";
import { formatMessage } from "./format.js";

/**
 * {@link formatMessage}, with text content blocks flattened to their text so
 * a streamed reply reads the same as a checkpointed one.
 */
function formatChatMessage(message: BaseMessage): string {
  if (Array.isArray(message.content)) {
    const blocks = message.content as Array<{ type?: unknown; text?: unknown }>;
    if (blocks.every((block) => block.type === "text")) {
      return blocks.map((block) => String(block.text ?? "")).join("");
    }
  }
  return formatMessage(message);
}

interface ChatState {
  messages: BaseMessage[];
}

interface Props {
  apiUrl: string;
  assistantId: string;
  /** One `submit-<i>` button per entry, sending it as a human message. */
  inputs?: string[];
  /** Payload of the `respond` button. */
  respondValue?: unknown;
  /**
   * Give the primary session LangGraph Platform's durable event history:
   * every `/stream/events` open replays what earlier opens received.
   */
  replay?: Omit<DurableReplayFetchOptions, "baseFetch">;
  transport?: "sse" | "websocket";
}

/** Milliseconds the primary session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

/**
 * Chat harness for streaming regressions that only show up across views of
 * one thread:
 *
 * - `reload` unmounts the primary `useStream` and mounts a fresh one on the
 *   same thread, like a page refresh.
 * - `observer-mount` opens a second, independent `useStream` on the thread,
 *   like another tab. Its test ids are prefixed with `observer-`.
 *
 * Each session also records what a user would have seen over time:
 * `count-history` lists every message count shown once hydration finished,
 * and `settled-with` the last message shown each time `isLoading` cleared.
 */
export function ChatSessionHarness({
  apiUrl,
  assistantId,
  inputs = ["Hello"],
  respondValue,
  replay,
  transport,
}: Props) {
  const durable = useMemo(
    () => (replay ? createDurableReplayFetch(replay) : undefined),
    []
  );
  const [threadId, setThreadId] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [observer, setObserver] = useState(false);

  useEffect(() => {
    if (mounted) return undefined;
    const timer = window.setTimeout(() => {
      setSession((current) => current + 1);
      setMounted(true);
    }, RELOAD_GAP_MS);
    return () => window.clearTimeout(timer);
  }, [mounted]);

  return (
    <div>
      <div data-testid="session">{session}</div>
      <div data-testid="thread-id">{threadId ?? "none"}</div>
      <button data-testid="reload" onClick={() => setMounted(false)}>
        Reload
      </button>
      <button
        data-testid="observer-mount"
        disabled={threadId == null}
        onClick={() => setObserver(true)}
      >
        Open observer
      </button>
      {mounted ? (
        <ChatSession
          key={session}
          prefix=""
          apiUrl={apiUrl}
          assistantId={assistantId}
          threadId={threadId}
          onThreadId={setThreadId}
          inputs={inputs}
          respondValue={respondValue}
          fetch={durable?.fetch}
          transport={transport}
        />
      ) : null}
      {observer && threadId != null ? (
        <ChatSession
          prefix="observer-"
          apiUrl={apiUrl}
          assistantId={assistantId}
          threadId={threadId}
          inputs={inputs}
          respondValue={respondValue}
        />
      ) : null}
    </div>
  );
}

interface SessionProps {
  prefix: string;
  apiUrl: string;
  assistantId: string;
  threadId: string | null;
  onThreadId?: (threadId: string) => void;
  inputs: string[];
  respondValue?: unknown;
  fetch?: typeof fetch;
  transport?: "sse" | "websocket";
}

function ChatSession({
  prefix,
  apiUrl,
  assistantId,
  threadId,
  onThreadId,
  inputs,
  respondValue,
  fetch: fetchImpl,
  transport,
}: SessionProps) {
  const [completed, setCompleted] = useState(0);
  const [respondError, setRespondError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const thread = useStream<ChatState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
    fetch: fetchImpl,
    transport,
    onCompleted: () => setCompleted((count) => count + 1),
  });

  const lastText =
    thread.messages.length > 0
      ? formatChatMessage(thread.messages[thread.messages.length - 1])
      : "";

  const [countHistory, setCountHistory] = useState<number[]>([]);
  useEffect(() => {
    if (thread.isThreadLoading) return;
    setCountHistory((history) =>
      history.at(-1) === thread.messages.length
        ? history
        : [...history, thread.messages.length]
    );
  }, [thread.isThreadLoading, thread.messages.length]);

  const wasLoading = useRef(false);
  const [settledWith, setSettledWith] = useState<string[]>([]);
  useEffect(() => {
    if (wasLoading.current && !thread.isLoading) {
      setSettledWith((history) => [...history, lastText]);
    }
    wasLoading.current = thread.isLoading;
  }, [thread.isLoading, lastText]);

  const id = (name: string) => `${prefix}${name}`;

  return (
    <div>
      <div data-testid={id("message-count")}>{thread.messages.length}</div>
      <div data-testid={id("transcript")}>
        {thread.messages.map(formatChatMessage).join(" | ")}
      </div>
      <div data-testid={id("ai-tool-calls")}>
        {thread.messages
          .filter((message) => AIMessage.isInstance(message))
          .flatMap((message) =>
            (message as AIMessage).tool_calls?.map((call) => call.id) ?? []
          )
          .join(",")}
      </div>
      <div data-testid={id("loading")}>
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid={id("thread-loading")}>
        {thread.isThreadLoading ? "Hydrating..." : "Ready"}
      </div>
      <div data-testid={id("interrupt-count")}>{thread.interrupts.length}</div>
      <div data-testid={id("error")}>
        {thread.error ? String(thread.error) : ""}
      </div>
      <div data-testid={id("respond-error")}>{respondError}</div>
      <div data-testid={id("submit-error")}>{submitError}</div>
      <div data-testid={id("count-history")}>{countHistory.join(",")}</div>
      <div data-testid={id("settled-with")}>{settledWith.join(" || ")}</div>
      <div data-testid={id("completed-count")}>{completed}</div>
      {inputs.map((input, i) => (
        <button
          key={input}
          data-testid={id(`submit-${i}`)}
          onClick={() => {
            setSubmitError("");
            void thread
              .submit({ messages: [new HumanMessage(input)] })
              .catch((error: unknown) => {
                setSubmitError(
                  error instanceof Error ? error.message : String(error)
                );
              });
          }}
        >
          {input}
        </button>
      ))}
      <button data-testid={id("stop")} onClick={() => void thread.stop()}>
        Stop
      </button>
      <button
        data-testid={id("respond")}
        onClick={() => {
          setRespondError("");
          void thread.respond(respondValue).catch((error: unknown) => {
            setRespondError(
              error instanceof Error ? error.message : String(error)
            );
          });
        }}
      >
        Respond
      </button>
    </div>
  );
}
