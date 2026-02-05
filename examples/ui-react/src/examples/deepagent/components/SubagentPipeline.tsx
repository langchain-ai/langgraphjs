import { useMemo } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import type { SubagentStream } from "@langchain/langgraph-sdk/react";
import { SubagentCard } from "./SubagentCard";

/**
 * Pipeline visualization showing all subagents
 */
export function SubagentPipeline({
  subagents,
  isLoading,
}: {
  subagents: SubagentStream[];
  isLoading: boolean;
}) {
  // Sort subagents by type for consistent display order
  const sortOrder = ["weather-scout", "experience-curator", "budget-optimizer"];
  const sortedSubagents = useMemo(() => {
    return [...subagents].sort((a, b) => {
      const aType = a.toolCall?.args?.subagent_type || "";
      const bType = b.toolCall?.args?.subagent_type || "";
      const aIndex = sortOrder.indexOf(aType);
      const bIndex = sortOrder.indexOf(bType);
      // Put unknown types at the end
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
    });
  }, [subagents]);

  if (sortedSubagents.length === 0) {
    return null;
  }

  const completedCount = sortedSubagents.filter(
    (s) => s.status === "complete"
  ).length;
  const totalCount = sortedSubagents.length;

  return (
    <div className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-accent/20 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-brand-accent" />
          </div>
          <div>
            <h3 className="font-medium text-neutral-200">
              Specialist Agents Working
            </h3>
            <p className="text-xs text-neutral-500">
              {completedCount}/{totalCount} completed
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-brand-accent text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Agents working in parallel...</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-neutral-800 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-linear-to-r from-sky-500 via-amber-500 to-emerald-500 transition-all duration-500"
          style={{ width: `${(completedCount / totalCount) * 100}%` }}
        />
      </div>

      {/* Subagent Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {sortedSubagents.map((subagent) => (
          <SubagentCard key={subagent.id} subagent={subagent} />
        ))}
      </div>
    </div>
  );
}
