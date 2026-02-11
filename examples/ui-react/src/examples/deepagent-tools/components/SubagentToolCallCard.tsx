import {
  Search,
  ThumbsUp,
  Tags,
  Database,
  Calculator,
  BarChart3,
  FileText,
  PenLine,
  SpellCheck,
  Loader2,
  Check,
  AlertCircle,
  ListTodo,
} from "lucide-react";
import type { ToolMessage } from "@langchain/langgraph-sdk";
import type {
  ToolCallWithResult,
  ToolCallState,
} from "@langchain/langgraph-sdk/react";

/**
 * Helper to parse tool result safely
 */
function parseToolResult(result?: ToolMessage): {
  status: string;
  [key: string]: unknown;
} {
  if (!result) return { status: "pending" };
  try {
    return JSON.parse(result.content as string);
  } catch {
    return { status: "success", content: result.content as string };
  }
}

/**
 * Get icon for a tool call
 */
function getToolIcon(name: string) {
  switch (name) {
    case "search_web":
      return <Search className="w-3.5 h-3.5" />;
    case "analyze_sentiment":
      return <ThumbsUp className="w-3.5 h-3.5" />;
    case "extract_keywords":
      return <Tags className="w-3.5 h-3.5" />;
    case "query_database":
      return <Database className="w-3.5 h-3.5" />;
    case "aggregate_data":
      return <Calculator className="w-3.5 h-3.5" />;
    case "generate_chart":
      return <BarChart3 className="w-3.5 h-3.5" />;
    case "draft_section":
      return <FileText className="w-3.5 h-3.5" />;
    case "edit_content":
      return <PenLine className="w-3.5 h-3.5" />;
    case "check_grammar":
      return <SpellCheck className="w-3.5 h-3.5" />;
    case "write_todos":
      return <ListTodo className="w-3.5 h-3.5" />;
    default:
      return <FileText className="w-3.5 h-3.5" />;
  }
}

/**
 * Get human-readable name for a tool
 */
function getToolDisplayName(name: string): string {
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Status indicator component
 */
function StatusIndicator({ state }: { state: ToolCallState }) {
  if (state === "pending") {
    return <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />;
  }
  if (state === "completed") {
    return <Check className="w-3 h-3 text-green-400" />;
  }
  return <AlertCircle className="w-3 h-3 text-red-400" />;
}

/**
 * Compact tool call card for display within subagent streams.
 * Shows the tool name, arguments summary, and result.
 */
export function SubagentToolCallCard({
  toolCall,
  accentColor = "text-neutral-400",
}: {
  toolCall: ToolCallWithResult;
  accentColor?: string;
}) {
  const { call, result, state } = toolCall;
  const parsedResult = parseToolResult(result);
  const isLoading = state === "pending";

  // Get a summary of the arguments
  const argsSummary = Object.entries(call.args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      let value: string;
      if (typeof v === "string") {
        value = v.length > 30 ? v.slice(0, 30) + "..." : v;
      } else if (Array.isArray(v)) {
        value = `[${v.length} items]`;
      } else if (typeof v === "object" && v !== null) {
        value =
          JSON.stringify(v).slice(0, 30) +
          (JSON.stringify(v).length > 30 ? "..." : "");
      } else {
        value = String(v);
      }
      return `${k}: ${value}`;
    })
    .join(", ");

  // Special handling for write_todos - show todos from arguments
  const isWriteTodos = call.name === "write_todos";
  const todosFromArgs = isWriteTodos
    ? (call.args.todos as
        | Array<{ content: string; status: string }>
        | undefined)
    : undefined;

  return (
    <div className="rounded-lg bg-black/30 border border-neutral-800/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-neutral-900/50">
        <div className={`${accentColor}`}>{getToolIcon(call.name)}</div>
        <span className="text-xs font-medium text-neutral-300">
          {getToolDisplayName(call.name)}
        </span>
        <div className="ml-auto">
          <StatusIndicator state={state} />
        </div>
      </div>

      {/* Special todos display for write_todos */}
      {isWriteTodos && todosFromArgs && todosFromArgs.length > 0 ? (
        <div className="px-3 py-2 text-xs border-t border-neutral-800/30">
          <div className="space-y-1.5">
            {todosFromArgs.map((todo, i) => (
              <div key={i} className="flex items-start gap-2">
                <span
                  className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                    todo.status === "completed"
                      ? "bg-green-400"
                      : todo.status === "in_progress"
                      ? "bg-yellow-400"
                      : "bg-neutral-500"
                  }`}
                />
                <span className="text-neutral-300">{todo.content}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Arguments (collapsed view) */}
          {argsSummary && (
            <div className="px-3 py-1.5 text-xs text-neutral-500 font-mono border-t border-neutral-800/30">
              {argsSummary}
            </div>
          )}

          {/* Result */}
          {!isLoading && result && (
            <div className="px-3 py-2 text-xs border-t border-neutral-800/30">
              {parsedResult.status === "success" ? (
                <div className="text-neutral-400">
                  {renderToolResult(call.name, parsedResult)}
                </div>
              ) : (
                <div className="text-red-400">
                  {(parsedResult.content as string | undefined) ||
                    "Error occurred"}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Render tool-specific result display
 */
function renderToolResult(
  toolName: string,
  result: Record<string, unknown>
): React.ReactNode {
  switch (toolName) {
    case "search_web": {
      const results = result.results as
        | Array<{ title: string; url: string }>
        | undefined;
      if (!results) return "Search completed";
      return (
        <div className="space-y-1">
          {results.slice(0, 2).map((r, i) => (
            <div key={i} className="truncate">
              <span className="text-neutral-300">{r.title}</span>
            </div>
          ))}
          {results.length > 2 && (
            <span className="text-neutral-500">+{results.length - 2} more</span>
          )}
        </div>
      );
    }

    case "analyze_sentiment": {
      const sentiment = result.sentiment as string;
      const confidence = result.confidence as string;
      return (
        <div className="flex items-center gap-2">
          <span
            className={`px-1.5 py-0.5 rounded text-xs ${
              sentiment === "positive"
                ? "bg-green-500/20 text-green-400"
                : sentiment === "negative"
                ? "bg-red-500/20 text-red-400"
                : "bg-neutral-500/20 text-neutral-400"
            }`}
          >
            {sentiment}
          </span>
          <span className="text-neutral-500">{confidence} confidence</span>
        </div>
      );
    }

    case "extract_keywords": {
      const keywords = result.keywords as string[] | undefined;
      if (!keywords) return "Keywords extracted";
      return (
        <div className="flex flex-wrap gap-1">
          {keywords.slice(0, 5).map((kw, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 bg-neutral-800 rounded text-xs text-neutral-300"
            >
              {kw}
            </span>
          ))}
        </div>
      );
    }

    case "query_database": {
      const count = result.count as number;
      const table = result.table as string;
      return `Found ${count} records in ${table}`;
    }

    case "aggregate_data": {
      const operation = result.operation as string;
      const value = result.result;
      return `${operation}: ${value}`;
    }

    case "generate_chart": {
      const chartType = result.chartType as string;
      const title = result.title as string;
      return `Created ${chartType} chart: "${title}"`;
    }

    case "draft_section": {
      const topic = result.topic as string;
      const wordCount = result.targetWordCount as number;
      return `Drafted ${wordCount} words on "${topic}"`;
    }

    case "edit_content": {
      return (result.changesSummary as string) || "Content edited";
    }

    case "check_grammar": {
      const score = result.overallScore as number;
      const issues = result.issues as Array<unknown> | undefined;
      return `Score: ${score}/100 (${issues?.length || 0} suggestions)`;
    }

    case "write_todos": {
      const todos = result.todos as
        | { content: string; status: string }[]
        | undefined;
      if (!todos || todos.length === 0) return "No todos";
      return (
        <div className="space-y-1">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  todo.status === "completed"
                    ? "bg-green-400"
                    : todo.status === "in_progress"
                    ? "bg-yellow-400"
                    : "bg-neutral-400"
                }`}
              />
              <span className="text-neutral-300 truncate">{todo.content}</span>
            </div>
          ))}
          {todos.length > 4 && (
            <span className="text-neutral-500">+{todos.length - 4} more</span>
          )}
        </div>
      );
    }

    default:
      return JSON.stringify(result).slice(0, 100);
  }
}
