import { Settings, Cloud, Loader2 } from "lucide-react";
import type { ToolMessage } from "@langchain/langgraph-sdk";
import type {
  ToolCallWithResult,
  ToolCallFromTool,
} from "@langchain/langgraph-sdk/react";
import type { getWeather } from "../examples/tool-calling-agent/agent.js";

// Define the tool calls type for our agent
export type AgentToolCalls =
  | ToolCallFromTool<typeof getWeather>
  | {
      name: "search";
      args: { query: string };
      id?: string;
      type?: "tool_call";
    };

/**
 * Component that renders a tool call with its result.
 * Demonstrates type-safe tool call handling with discriminated unions.
 */
export function ToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<AgentToolCalls>;
}) {
  const { call, result, state } = toolCall;
  const isLoading = state === "pending";

  // Type-safe rendering based on tool name
  // TypeScript narrows call.args based on call.name
  if (call.name === "get_weather") {
    return <WeatherToolCallCard call={call} result={result} state={state} />;
  }

  // Fallback for unknown tools (shouldn't happen with proper typing)
  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center gap-2 text-sm text-neutral-400 font-mono">
        <Settings className="w-4 h-4" />
        <span>{call.name}</span>
        {isLoading && (
          <div className="ml-auto">
            <Loader2 className="w-3 h-3 animate-spin text-brand-accent" />
          </div>
        )}
      </div>
      {result && (
        <div className="mt-3 text-xs text-neutral-400 font-mono bg-black rounded p-2 border border-neutral-800">
          {typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content)}
        </div>
      )}
    </div>
  );
}

function WeatherToolCallCard({
  call,
  result,
  state,
}: {
  call: ToolCallFromTool<typeof getWeather>;
  result?: ToolMessage;
  state: "pending" | "completed" | "error";
}) {
  const isLoading = state === "pending";
  const { status, content } = result
    ? JSON.parse(result.content as string)
    : { status: "success", content: "" };
  const isError = status === "error";

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-brand-dark/20 border border-brand-dark/30 flex items-center justify-center">
          <Cloud className="w-4 h-4 text-brand-accent" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">Weather</div>
          <div className="text-xs text-neutral-500 truncate">
            {call.args.location}
          </div>
        </div>
        {isLoading && (
          <Loader2 className="w-4 h-4 animate-spin text-brand-accent" />
        )}
      </div>

      {result && (
        <div
          className={`text-sm rounded-lg p-3 ${
            isError
              ? "bg-red-500/10 border border-red-500/20 text-red-400"
              : "bg-black border border-neutral-800 text-neutral-300"
          }`}
        >
          {content}
        </div>
      )}
    </div>
  );
}
