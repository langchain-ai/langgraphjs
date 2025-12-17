import type { ToolMessage } from "@langchain/langgraph-sdk";
import type {
  ToolCallWithResult,
  ToolCallFromTool,
} from "@langchain/langgraph-sdk/react";
import type { getWeather } from "../agent.mjs";

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
  const { call, result } = toolCall;
  const isLoading = result === undefined;

  // Type-safe rendering based on tool name
  // TypeScript narrows call.args based on call.name
  if (call.name === "get_weather") {
    // Here, call.args is typed as { location: string }
    return <WeatherToolCallCard call={call} result={result} />;
  }

  // Fallback for unknown tools (shouldn't happen with proper typing)
  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800">
      <div className="flex items-center gap-2 text-sm text-neutral-400 font-mono">
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        <span>{call.name}</span>
        {isLoading && (
          <div className="ml-auto">
            <div className="w-3 h-3 border border-neutral-600 border-t-white rounded-full animate-spin" />
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
}: {
  call: ToolCallFromTool<typeof getWeather>;
  result?: ToolMessage;
}) {
  const isLoading = result === undefined;
  const { status, content } = result
    ? JSON.parse(result.content as string)
    : { status: "success", content: "" };
  const isError = status === "error";

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center">
          <svg
            className="w-4 h-4 text-neutral-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
            />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">Weather</div>
          <div className="text-xs text-neutral-500 truncate">
            {call.args.location}
          </div>
        </div>
        {isLoading && (
          <div className="w-4 h-4 border border-neutral-600 border-t-white rounded-full animate-spin" />
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
