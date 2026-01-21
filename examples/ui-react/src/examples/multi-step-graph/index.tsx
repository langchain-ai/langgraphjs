import { useCallback } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  Search,
  Brain,
  FileEdit,
  CheckCircle,
  Target,
} from "lucide-react";

import type { ContentBlock } from "langchain";
import type { InferNodeNames } from "@langchain/langgraph-sdk";
import { useStream, type NodeStream } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";

interface NodeStyles {
  icon: React.ReactNode;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

type NodeName = InferNodeNames<typeof agent>;

/**
 * Node configuration for visual display.
 * Keys are type-safe based on the graph's node names.
 */
const NODE_CONFIG: Record<NodeName, NodeStyles> = {
  extract_topic: {
    icon: <Target className="w-4 h-4" />,
    label: "Topic Extraction",
    color: "text-violet-400",
    bgColor: "bg-violet-500/10",
    borderColor: "border-violet-500/30",
  },
  research_node: {
    icon: <Search className="w-4 h-4" />,
    label: "Research",
    color: "text-blue-400",
    bgColor: "bg-blue-500/10",
    borderColor: "border-blue-500/30",
  },
  analyze: {
    icon: <Brain className="w-4 h-4" />,
    label: "Analysis",
    color: "text-amber-400",
    bgColor: "bg-amber-500/10",
    borderColor: "border-amber-500/30",
  },
  draft_node: {
    icon: <FileEdit className="w-4 h-4" />,
    label: "Drafting",
    color: "text-emerald-400",
    bgColor: "bg-emerald-500/10",
    borderColor: "border-emerald-500/30",
  },
  review: {
    icon: <CheckCircle className="w-4 h-4" />,
    label: "Review",
    color: "text-rose-400",
    bgColor: "bg-rose-500/10",
    borderColor: "border-rose-500/30",
  },
};

/**
 * Pipeline visualization showing the workflow.
 * Derives node order dynamically from execution history.
 */
function PipelineVisualization({
  nodeExecutions,
}: {
  nodeExecutions: NodeStream<NodeName>[];
}) {
  // Get unique node names in execution order, filtered to known pipeline nodes
  const pipelineNodes = [...new Set(nodeExecutions.map((n) => n.name))].filter(
    (name) => NODE_CONFIG[name]
  );

  if (pipelineNodes.length === 0) return null;

  return (
    <div className="fixed right-6 top-1/2 -translate-y-1/2 z-50 bg-neutral-900/90 backdrop-blur-sm rounded-xl p-4 border border-neutral-800 shadow-xl">
      <div className="text-xs text-neutral-500 uppercase tracking-wider mb-4 font-medium text-center">
        Pipeline
      </div>
      <div className="flex flex-col items-center gap-1">
        {pipelineNodes.map((nodeName, idx) => {
          const config = NODE_CONFIG[nodeName];
          // Find the latest execution for this node
          const latestExecution = [...nodeExecutions]
            .reverse()
            .find((n) => n.name === nodeName);
          const isActive = latestExecution?.isLoading ?? false;
          const isComplete = latestExecution?.status === "complete";

          return (
            <div key={nodeName} className="flex flex-row items-start gap-3">
              {/* Icon column with connector */}
              <div className="flex flex-col items-center">
                <div
                  className={`
                  w-10 h-10 rounded-lg flex items-center justify-center
                  transition-all duration-300
                  ${
                    isActive
                      ? "opacity-100"
                      : isComplete
                      ? "opacity-80"
                      : "opacity-40"
                  }
                  ${
                    isActive
                      ? `${config.bgColor} ${
                          config.borderColor
                        } border-2 ring-2 ring-offset-2 ring-offset-neutral-900 ${config.borderColor.replace(
                          "border",
                          "ring"
                        )}`
                      : isComplete
                      ? `${config.bgColor} ${config.borderColor} border`
                      : "bg-neutral-800 border border-neutral-700"
                  }
                `}
                >
                  <span
                    className={
                      isActive || isComplete ? config.color : "text-neutral-500"
                    }
                  >
                    {config.icon}
                  </span>
                </div>
                {idx < pipelineNodes.length - 1 && (
                  <div
                    className={`
                    w-0.5 h-6 my-1
                    ${
                      isComplete
                        ? "bg-linear-to-b from-emerald-500/50 to-emerald-500/20"
                        : "bg-neutral-700"
                    }
                  `}
                  />
                )}
              </div>
              {/* Label */}
              <span
                className={`
                text-xs font-medium w-24 pt-2.5
                ${
                  isActive
                    ? "opacity-100"
                    : isComplete
                    ? "opacity-80"
                    : "opacity-40"
                }
                ${
                  isActive
                    ? config.color
                    : isComplete
                    ? "text-neutral-400"
                    : "text-neutral-600"
                }
              `}
              >
                {config.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Extract text content from a node stream's messages
 */
function getNodeContent(nodeStream: NodeStream): string {
  const aiMessages = nodeStream.messages.filter((m) => m.type === "ai");
  const lastMessage = aiMessages[aiMessages.length - 1];
  if (!lastMessage) return "";

  const content =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : Array.isArray(lastMessage.content)
      ? lastMessage.content.find(
          (c): c is ContentBlock.Text => c.type === "text" && "text" in c
        )?.text || ""
      : "";

  // Strip emoji headers
  return content.replace(/^[📌🔍🧠✍️✅]\s*\*\*.*?\*\*:?\n?/, "");
}

/**
 * Node output card - renders a node's streaming content
 */
function NodeOutputCard({
  nodeStream,
}: {
  nodeStream: NodeStream<NodeName>;
}) {
  const config = NODE_CONFIG[nodeStream.name];
  const content = getNodeContent(nodeStream);

  if (!content.trim()) return null;

  if (!config) {
    return (
      <div className="bg-neutral-800/50 rounded-xl p-4 border border-neutral-700">
        <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${config.bgColor} rounded-xl p-4 border ${config.borderColor} animate-fade-in`}
    >
      <div className="flex items-center gap-2 mb-3">
        <div
          className={`w-8 h-8 rounded-lg ${config.bgColor} border ${config.borderColor} flex items-center justify-center ${config.color}`}
        >
          {config.icon}
        </div>
        <span className={`text-sm font-semibold ${config.color}`}>
          {config.label}
        </span>
        {nodeStream.isLoading && (
          <div className="ml-auto w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        )}
      </div>
      <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
        {content}
      </div>
    </div>
  );
}

const CONTENT_WRITER_SUGGESTIONS = [
  "Write about AI in healthcare",
  "Create a guide on remote work",
  "Explain quantum computing",
];

export function MultiStepGraph() {
  const stream = useStream<typeof agent>({
    assistantId: "multi-step-graph",
    apiUrl: "http://localhost:2024",
  });

  const { scrollRef, contentRef } = useStickToBottom();

  // Get all node executions as an array, sorted by start time
  const nodeExecutions = Array.from(stream.nodes.values()).sort(
    (a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0)
  );

  const hasStarted = nodeExecutions.length > 0 || stream.messages.length > 0;

  // Get the currently active node (for loading indicator)
  const activeNode = stream.activeNodes[0];

  const handleSubmit = useCallback(
    (content: string) => {
      /**
       * @todo(@christian-bromann): Fix this type error.
       */
      stream.submit({ messages: [{ content, type: "human" } as any] });
    },
    [stream]
  );

  // Extract user's input from the first human message
  const userInput = stream.messages.find((m) => m.type === "human");
  const userContent =
    typeof userInput?.content === "string" ? userInput.content : "";

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {/* Fixed pipeline visualization on the right side */}
          {hasStarted && (
            <PipelineVisualization nodeExecutions={nodeExecutions} />
          )}

          {!hasStarted ? (
            <EmptyState
              icon={FileEdit}
              title="Content Writer Pipeline"
              description="A multi-node LangGraph workflow that researches, analyzes, drafts, and reviews content. Watch as your idea flows through each step of the pipeline."
              suggestions={CONTENT_WRITER_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {/* User's input */}
              {userContent && (
                <div className="flex justify-end">
                  <div className="bg-brand-accent/20 border border-brand-accent/30 rounded-xl px-4 py-2.5 max-w-[80%]">
                    <p className="text-sm text-white">{userContent}</p>
                  </div>
                </div>
              )}

              {/* Node outputs - render each node's stream */}
              {nodeExecutions
                .filter((ns) => NODE_CONFIG[ns.name]) // Only show pipeline nodes
                .map((nodeStream) => (
                  <NodeOutputCard key={nodeStream.id} nodeStream={nodeStream} />
                ))}

              {/* Loading indicator with current node info */}
              {stream.isLoading &&
                activeNode &&
                NODE_CONFIG[activeNode.name] && (
                  <div className="flex items-center gap-3 text-neutral-400 animate-pulse">
                    <LoadingIndicator />
                    <span className="text-sm">
                      Processing in {NODE_CONFIG[activeNode.name].label}...
                    </span>
                  </div>
                )}
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

      <MessageInput
        disabled={stream.isLoading}
        placeholder="What would you like me to write about?"
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/**
 * Register this example
 */
registerExample({
  id: "multi-step-graph",
  title: "Multi-Step Graph",
  description:
    "A content writer pipeline with multiple nodes showing state transitions and branching logic",
  category: "langgraph",
  icon: "graph",
  ready: true,
  component: MultiStepGraph,
});

export default MultiStepGraph;
