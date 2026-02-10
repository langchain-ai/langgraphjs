import { useEffect, useRef, useMemo } from "react";
import {
  Cloud,
  Compass,
  PiggyBank,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
} from "lucide-react";

import type {
  SubagentStream,
  InferSubagentNames,
} from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import type { agent } from "../agent";

type SubagentName = InferSubagentNames<typeof agent>;

/**
 * Extract streaming content from subagent messages.
 * This mirrors how the main stream handles messages.
 */
function getStreamingContent(messages: Message[]): string {
  return messages
    .filter((m) => m.type === "ai")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((c): c is { type: "text"; text: string } =>
            Boolean(c.type === "text" && c.text)
          )
          .map((c) => c.text)
          .join("");
      }
      return "";
    })
    .join("");
}

/**
 * Configuration for each subagent type
 */
const SUBAGENT_CONFIGS: Record<
  SubagentName,
  {
    icon: React.ReactNode;
    title: string;
    gradient: string;
    borderColor: string;
    bgColor: string;
    iconBg: string;
    accentColor: string;
  }
> = {
  "weather-scout": {
    icon: <Cloud className="w-5 h-5" />,
    title: "Weather Scout",
    gradient: "from-sky-500/20 to-blue-600/20",
    borderColor: "border-sky-500/40",
    bgColor: "bg-sky-950/30",
    iconBg: "bg-sky-500/20",
    accentColor: "text-sky-400",
  },
  "experience-curator": {
    icon: <Compass className="w-5 h-5" />,
    title: "Experience Curator",
    gradient: "from-amber-500/20 to-orange-600/20",
    borderColor: "border-amber-500/40",
    bgColor: "bg-amber-950/30",
    iconBg: "bg-amber-500/20",
    accentColor: "text-amber-400",
  },
  "budget-optimizer": {
    icon: <PiggyBank className="w-5 h-5" />,
    title: "Budget Optimizer",
    gradient: "from-emerald-500/20 to-teal-600/20",
    borderColor: "border-emerald-500/40",
    bgColor: "bg-emerald-950/30",
    iconBg: "bg-emerald-500/20",
    accentColor: "text-emerald-400",
  },
};

const DEFAULT_CONFIG = {
  icon: <Loader2 className="w-5 h-5 animate-spin" />,
  title: "Specialist Agent",
  gradient: "from-violet-500/20 to-purple-600/20",
  borderColor: "border-violet-500/40",
  bgColor: "bg-violet-950/30",
  iconBg: "bg-violet-500/20",
  accentColor: "text-violet-400",
};

/**
 * Get a human-readable title for a subagent type
 */
function getSubagentTitle(type?: SubagentName): string {
  if (!type) return "Specialist Agent";

  // Convert kebab-case to Title Case
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
      return <Clock className={`w-4 h-4 text-neutral-500`} />;
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
 * SubagentCard - Displays a single subagent's execution status and streaming content
 */
export function SubagentCard({
  subagent,
}: {
  subagent: SubagentStream<typeof agent>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const subagentType = subagent.toolCall.args.subagent_type;
  const config =
    (subagentType && SUBAGENT_CONFIGS[subagentType]) || DEFAULT_CONFIG;

  // Use configured title or generate from type
  const title =
    config.title !== DEFAULT_CONFIG.title
      ? config.title
      : getSubagentTitle(subagentType);

  // Get streaming content from messages (same pattern as main stream)
  const streamingContent = useMemo(
    () => getStreamingContent(subagent.messages),
    [subagent.messages]
  );

  // Auto-scroll as content streams in
  useEffect(() => {
    if (scrollRef.current && subagent.status === "running") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [streamingContent, subagent.status]);

  // Get display content
  const displayContent =
    subagent.status === "complete" ? subagent.result : streamingContent;

  // Get task description
  const taskDescription =
    subagent.toolCall.args.description || "Working on task...";

  return (
    <div
      className={`
        relative flex flex-col h-full rounded-2xl border-2 transition-all duration-300
        ${config.borderColor} ${config.bgColor}
        ${
          subagent.status === "running"
            ? "ring-2 ring-offset-2 ring-offset-black ring-opacity-50"
            : ""
        }
      `}
      style={{
        ["--ring-color" as string]: config.accentColor.replace("text-", ""),
      }}
    >
      {/* Card Header */}
      <div
        className={`
          flex items-center gap-3 px-4 py-3 border-b border-neutral-800/50
          bg-linear-to-r ${config.gradient} rounded-t-xl
        `}
      >
        <div
          className={`
            w-10 h-10 rounded-xl flex items-center justify-center
            ${config.iconBg} ${config.accentColor}
          `}
        >
          {config.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className={`font-semibold ${config.accentColor}`}>{title}</h3>
          <p className="text-xs text-neutral-500 truncate">{taskDescription}</p>
        </div>
        <StatusIcon status={subagent.status} accentColor={config.accentColor} />
      </div>

      {/* Content Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 min-h-0 max-h-64"
      >
        {displayContent ? (
          <div className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
            {displayContent}
            {subagent.status === "running" && (
              <span className="animate-pulse ml-1">▌</span>
            )}
          </div>
        ) : subagent.status === "running" || subagent.status === "pending" ? (
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
            Error: {subagent.error ? "Unknown error occurred" : null}
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
            <span>Started at {subagent.startedAt.toLocaleTimeString()}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
