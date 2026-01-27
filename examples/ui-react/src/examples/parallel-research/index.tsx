import { useRef, useCallback, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Sparkles,
  Wrench,
  GitFork,
  Loader2,
} from "lucide-react";

import type { InferNodeNames } from "@langchain/langgraph-sdk";
import { useStream, type NodeStream } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";

import { ResearchCard } from "./components/ResearchCard";
import { TopicBar } from "./components/TopicBar";
import { SelectedResearchDisplay } from "./components/SelectedResearchDisplay";
import type { ResearchId, ResearchConfig } from "./types";
import type { agent } from "./agent";

/**
 * Helper to extract the content from a node stream's messages.
 */
function getNodeContent(nodeStream: NodeStream | undefined): string {
  if (!nodeStream) return "";
  const aiMessages = nodeStream.messages.filter((m) => m.type === "ai");
  const lastMessage = aiMessages[aiMessages.length - 1];
  return typeof lastMessage?.content === "string" ? lastMessage.content : "";
}

const RESEARCH_CONFIGS: ResearchConfig[] = [
  {
    id: "analytical",
    name: "Analytical",
    nodeName: "researcher_analytical",
    icon: <BarChart3 className="w-5 h-5" />,
    description:
      "Data-driven, structured analysis with evidence-based insights",
    gradient: "from-cyan-500/20 to-blue-600/20",
    borderColor: "border-cyan-500/40",
    bgColor: "bg-cyan-950/30",
    iconBg: "bg-cyan-500/20",
    accentColor: "text-cyan-400",
  },
  {
    id: "creative",
    name: "Creative",
    nodeName: "researcher_creative",
    icon: <Sparkles className="w-5 h-5" />,
    description: "Narrative-driven storytelling with imaginative perspectives",
    gradient: "from-purple-500/20 to-pink-600/20",
    borderColor: "border-purple-500/40",
    bgColor: "bg-purple-950/30",
    iconBg: "bg-purple-500/20",
    accentColor: "text-purple-400",
  },
  {
    id: "practical",
    name: "Practical",
    nodeName: "researcher_practical",
    icon: <Wrench className="w-5 h-5" />,
    description: "Action-oriented guide with hands-on recommendations",
    gradient: "from-emerald-500/20 to-teal-600/20",
    borderColor: "border-emerald-500/40",
    bgColor: "bg-emerald-950/30",
    iconBg: "bg-emerald-500/20",
    accentColor: "text-emerald-400",
  },
];

const PARALLEL_RESEARCH_SUGGESTIONS = [
  "The future of renewable energy",
  "How AI is transforming healthcare",
  "Remote work best practices",
  "Cryptocurrency and blockchain explained",
];

export function ParallelResearch() {
  const stream = useStream<typeof agent>({
    assistantId: "parallel-research",
    apiUrl: "http://localhost:2024",
  });

  const [selectedResearch, setSelectedResearch] = useState<ResearchId | null>(
    null
  );
  const containerRef = useRef<HTMLDivElement>(null);

  // Simple derived state - no complex memos needed!
  const currentTopic = stream.values?.topic || null;
  const hasStarted = Boolean(currentTopic);

  /**
   * Get the node stream for a research config.
   * Falls back to state values for persistence after page refresh.
   */
  const getResearchData = (config: ResearchConfig) => {
    const nodeStreams = stream.getNodeStreamsByName(
      config.nodeName as InferNodeNames<typeof agent>
    );
    const nodeStream = nodeStreams[nodeStreams.length - 1];

    // Get content from node stream, fall back to persisted state
    const stateKey = `${config.id}Research` as keyof typeof stream.values;
    const content =
      getNodeContent(nodeStream) || (stream.values?.[stateKey] as string) || "";

    return {
      content,
      isLoading: nodeStream?.isLoading ?? false,
      isComplete: nodeStream ? !nodeStream.isLoading && !!content : !!content,
    };
  };

  // Check if all research is complete
  const isResearchComplete =
    !stream.isLoading &&
    RESEARCH_CONFIGS.every((config) => getResearchData(config).isComplete);

  const handleSubmit = useCallback(
    (content: string) => {
      setSelectedResearch(null);
      /**
       * @todo(@christian-bromann): Fix this type error.
       */
      stream.submit({ messages: [{ content, type: "human" } as any] });
    },
    [stream]
  );

  const handleSelectResearch = useCallback((researchId: ResearchId) => {
    setSelectedResearch(researchId);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <main className="flex-1 overflow-y-auto" ref={containerRef}>
        <div className="max-w-6xl mx-auto px-4 py-8">
          {!hasStarted ? (
            <EmptyState
              icon={GitFork}
              title="Parallel Research Explorer"
              description="Enter a topic and watch as three different AI research models analyze it simultaneously. Each brings a unique perspective: analytical, creative, and practical. Choose the approach that works best for you."
              suggestions={PARALLEL_RESEARCH_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <>
              {/* Topic Bar */}
              {currentTopic && <TopicBar topic={currentTopic} />}

              {/* Three Column Research Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                {RESEARCH_CONFIGS.map((config) => {
                  const { content, isLoading } = getResearchData(config);
                  return (
                    <div key={config.id} className="h-[500px]">
                      <ResearchCard
                        config={config}
                        content={content}
                        isLoading={isLoading}
                        isSelected={selectedResearch === config.id}
                        onSelect={() => handleSelectResearch(config.id)}
                        disabled={!isResearchComplete}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Selected Research Display */}
              {selectedResearch && (
                <SelectedResearchDisplay
                  config={
                    RESEARCH_CONFIGS.find((c) => c.id === selectedResearch)!
                  }
                  content={
                    getResearchData(
                      RESEARCH_CONFIGS.find((c) => c.id === selectedResearch)!
                    ).content
                  }
                />
              )}

              {/* Loading Status */}
              {stream.isLoading && !isResearchComplete && (
                <div className="mt-6 flex items-center justify-center gap-3 text-neutral-400">
                  <Loader2 className="w-5 h-5 animate-spin text-brand-accent" />
                  <span className="text-sm">
                    Research streaming in parallel...
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-6xl mx-auto px-4 pb-3">
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
        placeholder="Enter a research topic..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/**
 * Register this example
 */
registerExample({
  id: "parallel-research",
  title: "Parallel Research",
  description:
    "Watch 3 AI models research a topic in parallel, then pick your favorite result",
  category: "langgraph",
  icon: "graph",
  ready: true,
  component: ParallelResearch,
});

export default ParallelResearch;
