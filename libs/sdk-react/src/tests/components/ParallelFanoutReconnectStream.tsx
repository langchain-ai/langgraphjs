import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type {
  SubagentDiscoverySnapshot,
  SubgraphDiscoverySnapshot,
} from "@langchain/langgraph-sdk/stream";

import {
  useStream,
  useMessages,
  useToolCalls,
  STREAM_CONTROLLER,
} from "../../index.js";

type Thread = ReturnType<typeof useStream<{ messages: BaseMessage[] }>>;
type Card = SubagentDiscoverySnapshot | SubgraphDiscoverySnapshot;
type Kind = "subagent" | "subgraph";

interface Props {
  apiUrl: string;
  assistantId: string;
  kind: Kind;
  /**
   * Mount a scoped panel for *every* card at once (instead of behind a
   * per-card "open" click). Mirrors the playground, where each card's
   * `useMessages`/`useToolCalls` fire on mount and race the hydrate-time
   * discovery seed — the scenario the resolve-coalescing guards.
   */
  openAll?: boolean;
  openAllAfterReconnect?: boolean;
}

/**
 * Reconnect harness for parallel fan-out (subagents OR subgraphs).
 *
 * The producer runs a fan-out to completion; clicking "reconnect" bumps
 * a React `key` so a brand-new `useStream` remounts against the same
 * `threadId` — the real reconnect path (fresh controller → hydrate),
 * exercising checkpoint-seeded discovery. A wrapping `fetch` counts
 * `/history` POSTs so the test can assert the bounded getHistory
 * invariant after reconnect.
 */
export function ParallelFanoutReconnectStream({
  apiUrl,
  assistantId,
  kind,
  openAll = false,
  openAllAfterReconnect = false,
}: Props) {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [gen, setGen] = useState(0);
  const historyCount = useRef(0);

  const wrappedFetch = useMemo<typeof fetch>(() => {
    return (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      try {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;
        if (typeof url === "string" && url.includes("/history")) {
          historyCount.current += 1;
        }
      } catch {
        /* ignore url parse */
      }
      return fetch(input, init);
    };
  }, []);

  return (
    <div>
      <button
        data-testid="reconnect"
        disabled={threadId == null}
        onClick={() => {
          setGen((g) => g + 1);
        }}
      >
        Reconnect
      </button>
      <StreamView
        key={gen}
        apiUrl={apiUrl}
        assistantId={assistantId}
        kind={kind}
        openAll={openAll || (openAllAfterReconnect && gen > 0)}
        threadId={threadId}
        onThreadId={setThreadId}
        wrappedFetch={wrappedFetch}
        historyCount={historyCount}
      />
    </div>
  );
}

interface StreamViewProps {
  apiUrl: string;
  assistantId: string;
  kind: Kind;
  openAll: boolean;
  threadId: string | undefined;
  onThreadId: (id: string) => void;
  wrappedFetch: typeof fetch;
  historyCount: React.MutableRefObject<number>;
}

function StreamView({
  apiUrl,
  assistantId,
  kind,
  openAll,
  threadId,
  onThreadId,
  wrappedFetch,
  historyCount,
}: StreamViewProps) {
  useEffect(() => {
    historyCount.current = 0;
  }, [historyCount]);

  const thread = useStream<{ messages: BaseMessage[] }>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
    fetch: wrappedFetch,
  });

  const [openKey, setOpenKey] = useState<string | null>(null);

  // Count of mounted panels whose scoped messages have landed — used by
  // the "open all" test to wait for every card's lazy resolve to settle.
  const readyRef = useRef<Set<string>>(new Set());
  const [readyCount, setReadyCount] = useState(0);
  const markReady = useCallback((key: string, ready: boolean) => {
    const set = readyRef.current;
    if (ready === set.has(key)) return;
    if (ready) set.add(key);
    else set.delete(key);
    setReadyCount(set.size);
  }, []);

  const cards: Card[] = (
    kind === "subagent"
      ? [...thread.subagents.values()]
      : [...thread.subgraphs.values()]
  )
    .slice()
    .sort((a, b) => cardKey(a).localeCompare(cardKey(b)));

  const openCard = cards.find((c) => cardKey(c) === openKey) ?? null;

  return (
    <div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="root-message-count">{thread.messages.length}</div>
      <div data-testid="root-message-texts">
        {thread.messages
          .map((m) => (typeof m.text === "string" ? m.text : ""))
          .filter((t) => t.length > 0)
          .join("|")}
      </div>
      <div data-testid="subagent-count">{thread.subagents.size}</div>
      <div data-testid="subgraph-count">{thread.subgraphs.size}</div>
      <div data-testid="card-count">{cards.length}</div>
      <div data-testid="card-namespaces">
        {cards.map((c) => c.namespace.join("/")).join(",")}
      </div>
      <div data-testid="card-statuses">
        {cards.map((c) => c.status).join(",")}
      </div>
      <div data-testid="panels-ready">{readyCount}</div>
      <RegistryDiagnostics
        stream={thread}
        historyCount={historyCount}
      />

      <button
        data-testid="submit"
        onClick={() =>
          void thread.submit({
            messages: [new HumanMessage("Fan out the work")],
          })
        }
      >
        Run
      </button>

      {cards.map((c, i) => (
        <button
          key={cardKey(c)}
          data-testid={`open-${i}`}
          onClick={() => setOpenKey(cardKey(c))}
        >
          Open {i}
        </button>
      ))}
      <button data-testid="close-panel" onClick={() => setOpenKey(null)}>
        Close
      </button>

      {openAll
        ? cards.map((c, i) => (
            <CardPanel
              key={cardKey(c)}
              idx={i}
              stream={thread}
              card={c}
              onReady={markReady}
            />
          ))
        : openCard != null
          ? <CardPanel stream={thread} card={openCard} />
          : null}
    </div>
  );
}

function cardKey(card: Card): string {
  return card.namespace.join("/") || card.id;
}

function CardPanel({
  stream,
  card,
  idx,
  onReady,
}: {
  stream: Thread;
  card: Card;
  idx?: number;
  onReady?: (key: string, ready: boolean) => void;
}) {
  const messages = useMessages(stream, card);
  const toolCalls = useToolCalls(stream, card);
  useEffect(() => {
    onReady?.(cardKey(card), messages.length > 0);
  }, [onReady, card, messages.length]);
  return (
    <div data-testid={idx != null ? `panel-${idx}` : "panel"}>
      <div data-testid="panel-namespace">{card.namespace.join("/")}</div>
      <div data-testid="panel-messages-count">{messages.length}</div>
      <div data-testid="panel-toolcalls-count">{toolCalls.length}</div>
    </div>
  );
}

function RegistryDiagnostics({
  stream,
  historyCount,
}: {
  stream: Thread;
  historyCount: React.MutableRefObject<number>;
}) {
  const registry = stream[STREAM_CONTROLLER].registry;
  const [, setTick] = useState(0);
  useEffect(() => {
    const handle = setInterval(() => setTick((t) => t + 1), 25);
    return () => clearInterval(handle);
  }, []);
  return (
    <>
      <div data-testid="registry-size">{registry.size}</div>
      <div data-testid="history-request-count">{historyCount.current}</div>
    </>
  );
}
