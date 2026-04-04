import { useCallback, useState, useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  Brain,
  Database,
  Loader2,
  CheckCircle2,
  Trash2,
  Search,
  Save,
  Eye,
  MapPin,
} from "lucide-react";
import type { Message } from "@langchain/langgraph-sdk";
import type { HITLRequest, HITLResponse } from "langchain";
import { useStream, type ToolEvent } from "@langchain/langgraph-sdk/react";
import type {
  ToolCallWithResult,
  DefaultToolCall,
} from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";
import {
  memoryListImpl,
  memoryPutImpl,
  memoryGetImpl,
  memorySearchImpl,
  memoryForgetImpl,
  geolocationGetImpl,
} from "./tools";
import {
  PendingApprovalCard,
  DEFAULT_REJECT_REASON,
} from "../human-in-the-loop/components/PendingApprovalCard";

const MEMORY_SUGGESTIONS = [
  "What do you remember about me?",
  "Remember that my name is Alex and I'm a developer",
  "I prefer concise, technical answers",
  "What have I asked you to remember?",
  "Where am I right now?",
];

// Map tool names to icons
const TOOL_ICONS: Record<string, React.ReactNode> = {
  memory_put: <Save className="w-4 h-4" />,
  memory_get: <Eye className="w-4 h-4" />,
  memory_list: <Database className="w-4 h-4" />,
  memory_search: <Search className="w-4 h-4" />,
  memory_forget: <Trash2 className="w-4 h-4" />,
  geolocation_get: <MapPin className="w-4 h-4" />,
};

// Friendly names for memory tools
const TOOL_NAMES: Record<string, string> = {
  memory_put: "Saving to memory",
  memory_get: "Recalling memory",
  memory_list: "Listing memories",
  memory_search: "Searching memories",
  memory_forget: "Forgetting memory",
  geolocation_get: "Getting your location",
};

/**
 * Embedded OpenStreetMap showing a pinned location.
 * Uses the OSM export embed endpoint — no API key required.
 */
function LocationMap({
  latitude,
  longitude,
  accuracy,
  saved,
}: {
  latitude: number;
  longitude: number;
  accuracy?: number;
  saved?: boolean;
}) {
  // Choose a bbox delta that gives a comfortable street-level view (~500 m radius)
  const delta = 0.005;
  const bbox = `${longitude - delta},${latitude - delta},${longitude + delta},${
    latitude + delta
  }`;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${latitude},${longitude}`;
  const externalHref = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;

  return (
    <div className="space-y-2">
      <div
        className="overflow-hidden rounded-lg border border-neutral-700"
        style={{ height: 220 }}
      >
        <iframe
          src={src}
          title="Your location on OpenStreetMap"
          className="w-full h-full"
          style={{ border: 0 }}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-neutral-400">
          {latitude.toFixed(5)}, {longitude.toFixed(5)}
          {accuracy != null && (
            <span className="ml-2 text-neutral-500">
              ±{Math.round(accuracy)} m
            </span>
          )}
        </span>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-green-400 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Saved to memory
            </span>
          )}
          <a
            href={externalHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            Open in OSM ↗
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * Component to display headless tool execution status
 */
function HeadlessToolStatus({ events }: { events: ToolEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {events.map((event, idx) => {
        const icon = TOOL_ICONS[event.name] || <Brain className="w-4 h-4" />;
        const name = TOOL_NAMES[event.name] || event.name;

        return (
          <div
            key={idx}
            className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm ${
              event.phase === "start"
                ? "bg-purple-500/10 border border-purple-500/20 text-purple-400"
                : event.phase === "success"
                ? "bg-green-500/10 border border-green-500/20 text-green-400"
                : "bg-red-500/10 border border-red-500/20 text-red-400"
            }`}
          >
            {event.phase === "start" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : event.phase === "success" ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <AlertCircle className="w-4 h-4" />
            )}
            <span className="flex items-center gap-2">
              {icon}
              {event.phase === "start"
                ? `${name}...`
                : event.phase === "success"
                ? `${name} completed${
                    event.duration ? ` (${event.duration}ms)` : ""
                  }`
                : `${name} failed: ${event.error?.message}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders a memory value. If the value looks like a saved location it shows a
 * compact embedded map; otherwise it falls back to plain text / JSON.
 */
function MemoryValue({ value }: { value: unknown }) {
  if (
    value !== null &&
    typeof value === "object" &&
    "latitude" in value &&
    "longitude" in value
  ) {
    const loc = value as {
      latitude: number;
      longitude: number;
      accuracy?: number;
    };
    return (
      <LocationMap
        latitude={loc.latitude}
        longitude={loc.longitude}
        accuracy={loc.accuracy}
      />
    );
  }

  if (typeof value === "string")
    return <span className="truncate">{value}</span>;
  return (
    <pre className="text-xs overflow-auto whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/**
 * Generic tool call card for memory operations
 */
function MemoryToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<DefaultToolCall>;
}) {
  const { call, result, state } = toolCall;
  const isLoading = state === "pending";
  const icon = TOOL_ICONS[call.name] || <Brain className="w-4 h-4" />;

  // Parse result content if it's JSON
  let resultDisplay: React.ReactNode = null;
  if (result) {
    const content =
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content);

    try {
      const parsed = JSON.parse(content);
      // headless tool results are wrapped: { [callId]: actualResult }
      const data: Record<string, unknown> =
        call.id && parsed[call.id] !== undefined ? parsed[call.id] : parsed;

      if (data.latitude !== undefined && data.longitude !== undefined) {
        // Geolocation result — show an embedded OpenStreetMap
        resultDisplay = (
          <LocationMap
            latitude={data.latitude as number}
            longitude={data.longitude as number}
            accuracy={data.accuracy as number | undefined}
            saved={data.saved as boolean | undefined}
          />
        );
      } else if (data.count !== undefined && data.memories) {
        // Memory list result
        resultDisplay = (
          <div className="space-y-2">
            <div className="text-neutral-400">
              Found {data.count as number}{" "}
              {data.count === 1 ? "memory" : "memories"}
            </div>
            {(
              data.memories as {
                key: string;
                value: unknown;
                tags?: string[];
              }[]
            )
              .slice(0, 5)
              .map((m, i) => (
                <div key={i} className="bg-neutral-800/50 rounded p-2 text-xs">
                  <div className="font-medium text-white">{m.key}</div>
                  <div className="text-neutral-400">
                    <MemoryValue value={m.value} />
                  </div>
                  {m.tags && m.tags.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {m.tags.map((tag: string, ti: number) => (
                        <span
                          key={ti}
                          className="px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
          </div>
        );
      } else if (data.found !== undefined) {
        // Memory get result
        if (data.found) {
          resultDisplay = (
            <div className="space-y-1">
              <div className="font-medium text-white">{data.key as string}</div>
              <div className="text-neutral-300">
                <MemoryValue value={data.value} />
              </div>
            </div>
          );
        } else {
          resultDisplay = data.message as string;
        }
      } else if (data.message) {
        resultDisplay = data.message as string;
      } else {
        resultDisplay = (
          <pre className="text-xs overflow-auto whitespace-pre-wrap">
            {JSON.stringify(data, null, 2)}
          </pre>
        );
      }
    } catch {
      resultDisplay = content;
    }
  }

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">
            {TOOL_NAMES[call.name] ||
              call.name
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase())}
          </div>
          {call.args && Object.keys(call.args).length > 0 && (
            <div className="text-xs text-neutral-500 truncate">
              {call.name === "memory_put" && call.args.key
                ? `Key: ${call.args.key}`
                : call.name === "memory_search" && call.args.query
                ? `Query: "${call.args.query}"`
                : JSON.stringify(call.args)}
            </div>
          )}
        </div>
        {isLoading && (
          <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
        )}
      </div>

      {resultDisplay && (
        <div className="text-sm rounded-lg p-3 bg-black border border-neutral-800 text-neutral-300">
          {resultDisplay}
        </div>
      )}
    </div>
  );
}

/**
 * Memory stats component showing what's stored
 */
function MemoryStats() {
  const [stats, setStats] = useState<{
    count: number;
    tags: string[];
    loading: boolean;
  }>({
    count: 0,
    tags: [],
    loading: true,
  });

  useEffect(() => {
    // Quick check of IndexedDB for memory stats
    const checkMemories = async () => {
      try {
        const request = indexedDB.open("agent-memory", 2);
        request.onsuccess = () => {
          const db = request.result;
          if (db.objectStoreNames.contains("memories")) {
            const transaction = db.transaction("memories", "readonly");
            const store = transaction.objectStore("memories");
            const countRequest = store.count();
            const allRequest = store.getAll();

            countRequest.onsuccess = () => {
              allRequest.onsuccess = () => {
                const memories = allRequest.result as Array<{
                  tags: string[];
                }>;
                const allTags = new Set<string>();
                memories.forEach((m) => m.tags?.forEach((t) => allTags.add(t)));
                setStats({
                  count: countRequest.result,
                  tags: Array.from(allTags).slice(0, 5),
                  loading: false,
                });
              };
            };
          } else {
            setStats({ count: 0, tags: [], loading: false });
          }
          db.close();
        };
        request.onerror = () => {
          setStats({ count: 0, tags: [], loading: false });
        };
      } catch {
        setStats({ count: 0, tags: [], loading: false });
      }
    };

    checkMemories();

    // Refresh stats periodically
    const interval = setInterval(checkMemories, 5000);
    return () => clearInterval(interval);
  }, []);

  if (stats.loading) return null;

  return (
    <div className="flex items-center gap-4 text-xs text-neutral-500">
      <div className="flex items-center gap-1.5">
        <Database className="w-3 h-3" />
        <span>
          {stats.count} {stats.count === 1 ? "memory" : "memories"} stored
        </span>
      </div>
      {stats.tags.length > 0 && (
        <div className="flex items-center gap-1">
          {stats.tags.map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 bg-neutral-800 rounded text-neutral-400"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Helper to check if a message has actual text content.
 */
function hasContent(message: Message): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message.content)) {
    return message.content.some(
      (c) => c.type === "text" && c.text.trim().length > 0
    );
  }
  return false;
}

export function HeadlessToolsAgent() {
  // Track headless tool events for display
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [isProcessingHitl, setIsProcessingHitl] = useState(false);

  const stream = useStream<typeof agent, { InterruptType: HITLRequest }>({
    assistantId: "headless-tools",
    apiUrl: "http://localhost:2024",
    // Register headless tools - these will execute locally when the agent calls them
    tools: [
      memoryListImpl,
      memoryPutImpl,
      memoryGetImpl,
      memorySearchImpl,
      memoryForgetImpl,
      geolocationGetImpl,
    ],
    // Track headless tool lifecycle events
    onTool: (event) => {
      setToolEvents((prev) => {
        // On start, add the event
        if (event.phase === "start") {
          return [...prev, event];
        }
        // On complete/error, update the event
        return prev.map((e) =>
          e.name === event.name && e.phase === "start" ? event : e
        );
      });

      // Clear events after a delay on success/error
      if (event.phase !== "start") {
        setTimeout(() => {
          setToolEvents((prev) => prev.filter((e) => e.name !== event.name));
        }, 2000);
      }
    },
  });

  const { scrollRef, contentRef } = useStickToBottom();

  const hasMessages = stream.messages.length > 0;
  const hitlRequest = stream.interrupt?.value as HITLRequest | undefined;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  const handleHitlApprove = useCallback(async () => {
    if (!hitlRequest) return;
    setIsProcessingHitl(true);
    try {
      const decisions: HITLResponse["decisions"] =
        hitlRequest.actionRequests.map(() => ({ type: "approve" as const }));
      await stream.submit(null, {
        command: { resume: { decisions } as HITLResponse },
      });
    } finally {
      setIsProcessingHitl(false);
    }
  }, [hitlRequest, stream]);

  const handleHitlReject = useCallback(
    async (index: number, reason: string) => {
      if (!hitlRequest) return;
      setIsProcessingHitl(true);
      try {
        const decisions: HITLResponse["decisions"] =
          hitlRequest.actionRequests.map((_, i) =>
            i === index
              ? {
                  type: "reject" as const,
                  message: reason || DEFAULT_REJECT_REASON,
                }
              : {
                  type: "reject" as const,
                  message: "Rejected along with other actions",
                }
          );
        await stream.submit(null, {
          command: { resume: { decisions } as HITLResponse },
        });
      } finally {
        setIsProcessingHitl(false);
      }
    },
    [hitlRequest, stream]
  );

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages && !stream.interrupt ? (
            <EmptyState
              icon={Brain}
              title="Long-Term Memory Agent"
              description="An AI assistant that remembers you across sessions. Memory tools run in your browser; each geolocation request is paused for your approval first, then the client executes the tool (same pattern as headless tools + HITL)."
              suggestions={MEMORY_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => {
                // For AI messages, check if they have tool calls
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  // Render tool calls if present
                  if (toolCalls.length > 0) {
                    return (
                      <div key={message.id} className="flex flex-col gap-3">
                        {toolCalls.map((toolCall) => (
                          <MemoryToolCallCard
                            key={toolCall.id}
                            toolCall={toolCall}
                          />
                        ))}
                      </div>
                    );
                  }

                  // Skip AI messages without content
                  if (!hasContent(message)) {
                    return null;
                  }
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Human approval before geolocation (HITL + headless tools) */}
              {hitlRequest && hitlRequest.actionRequests.length > 0 && (
                <div className="flex flex-col gap-4">
                  {hitlRequest.actionRequests.map((actionRequest, idx) => (
                    <PendingApprovalCard
                      key={idx}
                      actionRequest={actionRequest}
                      reviewConfig={hitlRequest.reviewConfigs[idx]}
                      onApprove={() => void handleHitlApprove()}
                      onReject={(reason) => handleHitlReject(idx, reason)}
                      onEdit={() => {}}
                      isProcessing={isProcessingHitl}
                    />
                  ))}
                </div>
              )}

              {/* Show headless tool execution status */}
              <HeadlessToolStatus events={toolEvents} />

              {/* Show loading indicator when streaming and no content yet */}
              {stream.isLoading &&
                !stream.interrupt &&
                !stream.messages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                stream.toolCalls.length === 0 &&
                toolEvents.length === 0 && <LoadingIndicator />}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-neutral-800 bg-black/50">
        <div className="max-w-2xl mx-auto px-4 py-2">
          <MemoryStats />
        </div>
        <MessageInput
          disabled={stream.isLoading || isProcessingHitl || !!stream.interrupt}
          placeholder={
            stream.interrupt
              ? "Approve or reject location access above…"
              : "Tell me something to remember, or ask what I know about you..."
          }
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}

// Register this example
registerExample({
  id: "headless-tools",
  title: "Long-Term Memory",
  description:
    "Local browser memory + headless tools; geolocation is gated with human-in-the-loop",
  category: "agents",
  icon: "tool",
  ready: true,
  component: HeadlessToolsAgent,
});

export default HeadlessToolsAgent;
