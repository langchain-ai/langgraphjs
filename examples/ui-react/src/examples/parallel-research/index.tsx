import { useRef, useCallback, useState, useMemo } from "react";
import {
  AlertCircle,
  BarChart3,
  Sparkles,
  Wrench,
  GitFork,
  Loader2,
} from "lucide-react";

import { useStream } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";

import { ResearchCard } from "./components/ResearchCard";
import { TopicBar } from "./components/TopicBar";
import { SelectedResearchDisplay } from "./components/SelectedResearchDisplay";
import type { ResearchContents, ResearchId, ResearchConfig } from "./types";
import type { agent } from "./agent";

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

  /**
   * Extract streaming research content from messages using metadata
   * This allows us to show content as it streams in real-time
   */
  const streamingContents = useMemo((): ResearchContents => {
    const contents: ResearchContents = {
      analytical: "",
      creative: "",
      practical: "",
    };

    /**
     * Track streaming messages by their langgraph_node metadata
     */
    for (const message of stream.messages) {
      if (message.type !== "ai") continue;

      /**
       * Get the stream metadata for this message
       */
      const metadata = stream.getMessagesMetadata?.(message);
      const nodeFromMetadata = metadata?.streamMetadata?.langgraph_node as
        | string
        | undefined;

      /**
       * Also check the message name (set after node completion)
       */
      const nodeName = (message as { name?: string }).name;
      const node = nodeFromMetadata || nodeName;

      if (!node) continue;

      const content =
        typeof message.content === "string" ? message.content : "";

      if (node === "researcher_analytical" && content) {
        contents.analytical = content;
      } else if (node === "researcher_creative" && content) {
        contents.creative = content;
      } else if (node === "researcher_practical" && content) {
        contents.practical = content;
      }
    }

    return contents;
  }, [stream.messages, stream.getMessagesMetadata]);

  /**
   * Get research contents - prefer streaming content, fall back to state values
   */
  const researchContents = useMemo((): ResearchContents => {
    return {
      analytical:
        streamingContents.analytical || stream.values?.analyticalResearch || "",
      creative:
        streamingContents.creative || stream.values?.creativeResearch || "",
      practical:
        streamingContents.practical || stream.values?.practicalResearch || "",
    };
  }, [
    streamingContents,
    stream.values?.analyticalResearch,
    stream.values?.creativeResearch,
    stream.values?.practicalResearch,
  ]);

  /**
   * Get the current topic directly from state
   */
  const currentTopic = stream.values?.topic || null;

  /**
   * Check which researchers are currently loading (streaming but not complete)
   * Since all 3 researchers run in parallel, they're all "loading" until the collector runs
   */
  const loadingStates = useMemo(() => {
    const activeNodes = new Set<ResearchId>();
    const currentNode = stream.values?.currentNode || "";

    // If we're loading and the collector hasn't finished, all researchers are considered active
    if (stream.isLoading && currentTopic && currentNode !== "collector") {
      activeNodes.add("analytical");
      activeNodes.add("creative");
      activeNodes.add("practical");
    }

    return activeNodes;
  }, [stream.isLoading, currentTopic, stream.values?.currentNode]);

  /**
   * Check if all research is complete
   */
  const isResearchComplete = useMemo(() => {
    const currentNode = stream.values?.currentNode || "";
    return (
      !stream.isLoading &&
      currentNode === "collector" &&
      Boolean(researchContents.analytical) &&
      Boolean(researchContents.creative) &&
      Boolean(researchContents.practical)
    );
  }, [stream.isLoading, stream.values?.currentNode, researchContents]);

  const hasStarted = Boolean(stream.values?.topic);

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
                {RESEARCH_CONFIGS.map((config) => (
                  <div key={config.id} className="h-[500px]">
                    <ResearchCard
                      config={config}
                      content={researchContents[config.id] || ""}
                      isLoading={loadingStates.has(config.id)}
                      isSelected={selectedResearch === config.id}
                      onSelect={() => handleSelectResearch(config.id)}
                      disabled={!isResearchComplete}
                    />
                  </div>
                ))}
              </div>

              {/* Selected Research Display */}
              {selectedResearch && (
                <SelectedResearchDisplay
                  config={
                    RESEARCH_CONFIGS.find((c) => c.id === selectedResearch)!
                  }
                  content={researchContents[selectedResearch] || ""}
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
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
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
