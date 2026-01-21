import { useEffect, useRef, useMemo, useState } from "react";
import {
  Search,
  BarChart3,
  PenLine,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Wrench,
} from "lucide-react";
import type { SubagentStream } from "@langchain/langgraph-sdk/react";

import { SubagentToolCallCard } from "./SubagentToolCallCard";
import { SUBAGENT_CONFIGS, type SubagentType } from "../types";

/**
 * Message interface for subagent messages
 */
interface SubagentMessage {
  id?: string;
  type: "human" | "ai" | "tool" | "system";
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
}

/**
 * Default configuration for unknown subagent types
 */
const DEFAULT_CONFIG = {
  icon: "tool",
  title: "Specialist Agent",
  gradient: "from-violet-500/20 to-purple-600/20",
  borderColor: "border-violet-500/40",
  bgColor: "bg-violet-950/30",
  iconBg: "bg-violet-500/20",
  accentColor: "text-violet-400",
};

/**
 * Get icon component for a subagent type
 */
function getSubagentIcon(type: string | undefined) {
  switch (type) {
    case "researcher":
      return <Search className="w-5 h-5" />;
    case "data-analyst":
      return <BarChart3 className="w-5 h-5" />;
    case "content-writer":
      return <PenLine className="w-5 h-5" />;
    default:
      return <Loader2 className="w-5 h-5 animate-spin" />;
  }
}

/**
 * Extract streaming content from subagent messages.
 */
function getStreamingContent(messages: SubagentMessage[]): string {
  return messages
    .filter((m) => m.type === "ai")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("");
      }
      return "";
    })
    .join("");
}

/**
 * Status icon component
 */
function StatusIcon({
  status,
  accentColor,
}: {
  status: string;
  accentColor: string;
}) {
  switch (status) {
    case "pending":
      return <Clock className="w-4 h-4 text-neutral-500" />;
    case "running":
      return <Loader2 className={`w-4 h-4 animate-spin ${accentColor}`} />;
    case "complete":
      return <CheckCircle2 className="w-4 h-4 text-green-400" />;
    case "error":
      return <AlertCircle className="w-4 h-4 text-red-400" />;
    default:
      return null;
  }
}

/**
 * SubagentStreamCard - Displays a subagent's execution including streaming content AND tool calls
 */
export function SubagentStreamCard({
  subagent,
  defaultExpanded = true,
}: {
  subagent: SubagentStream;
  defaultExpanded?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const subagentType = subagent.toolCall?.args?.subagent_type as
    | SubagentType
    | undefined;
  const config =
    (subagentType && SUBAGENT_CONFIGS[subagentType]) || DEFAULT_CONFIG;

  // Get streaming content from messages
  const streamingContent = useMemo(
    () => getStreamingContent(subagent.messages as SubagentMessage[]),
    [subagent.messages]
  );

  // Get tool calls from the subagent
  const toolCalls = subagent.toolCalls;

  // Auto-scroll as content streams in
  useEffect(() => {
    if (scrollRef.current && subagent.status === "running" && isExpanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingContent, toolCalls.length, subagent.status, isExpanded]);

  // Get display content
  const displayContent =
    subagent.status === "complete" ? subagent.result : streamingContent;

  // Get task description
  const taskDescription =
    subagent.toolCall.args.description || "Working on task...";

  const hasToolCalls = toolCalls.length > 0;
  const hasContent = !!displayContent;

  return (
    <div
      className={`
        relative flex flex-col rounded-2xl border-2 transition-all duration-300
        ${config.borderColor} ${config.bgColor}
        ${
          subagent.status === "running"
            ? "ring-2 ring-offset-2 ring-offset-black ring-opacity-50"
            : ""
        }
      `}
    >
      {/* Card Header */}
      <div
        className={`
          flex items-center gap-3 px-4 py-3 cursor-pointer
          bg-linear-to-r ${config.gradient} rounded-t-xl
          ${!isExpanded ? "rounded-b-xl" : "border-b border-neutral-800/50"}
        `}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center
            ${config.iconBg} ${config.accentColor}
          `}
        >
          {getSubagentIcon(subagentType)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className={`font-semibold ${config.accentColor}`}>
              {config.title}
            </h3>
            {hasToolCalls && (
              <span className="flex items-center gap-1 text-xs text-neutral-500">
                <Wrench className="w-3 h-3" />
                {toolCalls.length}
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500 truncate">{taskDescription}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusIcon
            status={subagent.status}
            accentColor={config.accentColor}
          />
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-neutral-500" />
          ) : (
            <ChevronRight className="w-4 h-4 text-neutral-500" />
          )}
        </div>
      </div>

      {/* Expandable Content */}
      {isExpanded && (
        <>
          {/* Tool Calls Section */}
          {hasToolCalls && (
            <div className="px-4 py-3 border-b border-neutral-800/50">
              <div className="flex items-center gap-2 mb-2">
                <Wrench className="w-3.5 h-3.5 text-neutral-500" />
                <span className="text-xs font-medium text-neutral-400">
                  Tool Calls ({toolCalls.length})
                </span>
              </div>
              <div className="space-y-2">
                {toolCalls.map((tc) => (
                  <SubagentToolCallCard
                    key={tc.id}
                    toolCall={tc}
                    accentColor={config.accentColor}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Streaming Content Area */}
          <div
            ref={scrollRef}
            className="overflow-y-auto px-4 py-4 min-h-0 max-h-64"
          >
            {hasContent ? (
              <div className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
                {displayContent}
                {subagent.status === "running" && (
                  <span className="animate-pulse ml-1">▌</span>
                )}
              </div>
            ) : subagent.status === "running" ||
              subagent.status === "pending" ? (
              <div className="flex items-center gap-2 text-neutral-500 animate-pulse">
                <div className="w-2 h-2 rounded-full bg-current" />
                <div
                  className="w-2 h-2 rounded-full bg-current"
                  style={{ animationDelay: "150ms" }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-current"
                  style={{ animationDelay: "300ms" }}
                />
                <span className="text-sm ml-2">
                  {subagent.status === "pending" ? "Queued..." : "Working..."}
                </span>
              </div>
            ) : subagent.status === "error" ? (
              <div className="text-red-400 text-sm">
                Error:{" "}
                {(subagent.error as string | undefined) ||
                  "Unknown error occurred"}
              </div>
            ) : null}
          </div>

          {/* Footer with timing */}
          {(subagent.startedAt || subagent.completedAt) && (
            <div className="px-4 py-2 border-t border-neutral-800/50 text-xs text-neutral-500">
              {subagent.completedAt && subagent.startedAt ? (
                <span>
                  Completed in{" "}
                  {(
                    (subagent.completedAt.getTime() -
                      subagent.startedAt.getTime()) /
                    1000
                  ).toFixed(1)}
                  s
                </span>
              ) : subagent.startedAt ? (
                <span>
                  Started at {subagent.startedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
