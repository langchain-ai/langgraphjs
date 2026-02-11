import { useMemo } from "react";
import type { SubagentStream } from "@langchain/langgraph-sdk/react";
import { Layers, Loader2 } from "lucide-react";

import type { SubagentType } from "../types";
import { SubagentStreamCard } from "./SubagentStreamCard";

/**
 * Sort subagents by type for consistent display order
 */
const SORT_ORDER: SubagentType[] = [
  "researcher",
  "data-analyst",
  "content-writer",
];

/**
 * Pipeline visualization showing all subagents with their tool calls
 */
export function SubagentPipeline({
  subagents,
  isLoading,
}: {
  subagents: SubagentStream[];
  isLoading: boolean;
}) {
  const sortedSubagents = useMemo(
    () =>
      [...subagents].sort((a, b) => {
        const aType = (a.toolCall?.args?.subagent_type as SubagentType) || "";
        const bType = (b.toolCall?.args?.subagent_type as SubagentType) || "";
        const aIndex = SORT_ORDER.indexOf(aType);
        const bIndex = SORT_ORDER.indexOf(bType);
        return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
      }),
    [subagents]
  );

  if (sortedSubagents.length === 0) {
    return null;
  }

  const completedCount = sortedSubagents.filter(
    (s) => s.status === "complete"
  ).length;
  const totalCount = sortedSubagents.length;

  // Count total tool calls across all subagents
  const totalToolCalls = sortedSubagents.reduce(
    (acc, s) => acc + s.toolCalls.length,
    0
  );

  return (
    <div className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-accent/20 flex items-center justify-center">
            <Layers className="w-4 h-4 text-brand-accent" />
          </div>
          <div>
            <h3 className="font-medium text-neutral-200">Subagent Pipeline</h3>
            <p className="text-xs text-neutral-500">
              {completedCount}/{totalCount} agents • {totalToolCalls} tool calls
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-brand-accent text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Agents working...</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-neutral-800 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-linear-to-r from-blue-500 via-purple-500 to-rose-500 transition-all duration-500"
          style={{ width: `${(completedCount / totalCount) * 100}%` }}
        />
      </div>

      {/* Subagent Cards - Vertical Stack for better tool call visibility */}
      <div className="space-y-4">
        {sortedSubagents.map((subagent) => (
          <SubagentStreamCard
            key={subagent.id}
            subagent={subagent}
            defaultExpanded={
              subagent.status === "running" || subagent.toolCalls.length > 0
            }
          />
        ))}
      </div>
    </div>
  );
}
