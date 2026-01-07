import {
  Settings,
  Cloud,
  Loader2,
  Calculator,
  Check,
  MapPin,
  Wind,
  Droplets,
  Equal,
  Sun,
  CloudRain,
  Snowflake,
  CloudLightning,
  Lightbulb,
  FlaskConical,
  Landmark,
  TreePine,
} from "lucide-react";
import type { ToolMessage } from "@langchain/langgraph-sdk";
import type {
  ToolCallWithResult,
  ToolCallFromTool,
  ToolCallState,
  InferAgentToolCalls,
} from "@langchain/langgraph-sdk/react";
import type { 
  agent as ToolCallingAgent,
  getWeather
} from "../examples/tool-calling-agent/agent.js";
import type { agent as SummarizationAgent } from "../examples/summarization-agent/agent.js";
import type {
  agent as BranchingAgent,
  getFact,
  calculate,
} from "../examples/branching-chat/agent.js";
import type { takeNote } from "../examples/summarization-agent/agent.js";

// Define the tool calls type for our agent
export type AgentToolCalls =
  /**
   * Infer tool call type from the tool
   */
  | ToolCallFromTool<typeof getWeather>
  /**
   * Infer tool call from an agent instance
   */
  | InferAgentToolCalls<typeof ToolCallingAgent>
  | InferAgentToolCalls<typeof SummarizationAgent>
  | InferAgentToolCalls<typeof BranchingAgent>;

/**
 * Helper to parse tool result safely
 * @param result - The result of the tool call
 * @returns { status: string; content: string } - The parsed result
 */
function parseToolResult(result?: ToolMessage): {
  status: string;
  content: string;
} {
  if (!result) return { status: "pending", content: "" };
  try {
    return JSON.parse(result.content as string);
  } catch {
    return { status: "success", content: result.content as string };
  }
}

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

  if (call.name === "get_weather") {
    return <WeatherToolCallCard call={call} result={result} state={state} />;
  }

  if (call.name === "calculate") {
    return <CalculatorToolCallCard call={call} result={result} state={state} />;
  }

  if (call.name === "take_note") {
    return <NoteToolCallCard call={call} result={result} state={state} />;
  }

  if (call.name === "get_fact") {
    return <FactToolCallCard call={call} result={result} state={state} />;
  }

  // Fallback for unknown tools
  return <GenericToolCallCard {...toolCall} />;
}

/**
 * Generic tool call card for unknown tools
 */
function GenericToolCallCard({
  call,
  result,
  state,
}: {
  call: { name: string; args: Record<string, unknown> };
  result?: ToolMessage;
  state: ToolCallState;
}) {
  const isLoading = state === "pending";
  const parsedResult = parseToolResult(result);

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center">
          <Settings className="w-4 h-4 text-neutral-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white font-mono">
            {call.name}
          </div>
          <div className="text-xs text-neutral-500">
            {isLoading ? "Processing..." : "Completed"}
          </div>
        </div>
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-brand-accent" />
        ) : (
          parsedResult.status === "success" && (
            <Check className="w-4 h-4 text-green-400" />
          )
        )}
      </div>
      {result && (
        <div className="text-sm rounded-lg p-3 bg-black border border-neutral-800 text-neutral-300 font-mono">
          {parsedResult.content}
        </div>
      )}
    </div>
  );
}

/**
 * Parse weather content string into structured data
 */
function parseWeatherContent(content: string): {
  location: string;
  condition: string;
  temperature: string;
  wind: string;
  humidity: string;
} | null {
  // Pattern: "Weather in City, Country: Condition, Temp°C, Wind: X km/h, Humidity: Y%"
  const match = content.match(
    /Weather in ([^:]+): ([^,]+), ([^,]+), Wind: ([^,]+), Humidity: (.+)/
  );
  if (!match) return null;
  return {
    location: match[1],
    condition: match[2],
    temperature: match[3],
    wind: match[4],
    humidity: match[5],
  };
}

/**
 * Get weather icon based on condition
 */
function getWeatherIcon(condition: string) {
  const c = condition.toLowerCase();
  if (c.includes("rain") || c.includes("drizzle") || c.includes("shower")) {
    return <CloudRain className="w-8 h-8 text-sky-300" />;
  }
  if (c.includes("snow")) {
    return <Snowflake className="w-8 h-8 text-blue-200" />;
  }
  if (c.includes("thunder")) {
    return <CloudLightning className="w-8 h-8 text-yellow-300" />;
  }
  if (c.includes("cloud") || c.includes("overcast") || c.includes("fog")) {
    return <Cloud className="w-8 h-8 text-neutral-300" />;
  }
  return <Sun className="w-8 h-8 text-amber-300" />;
}

/**
 * Weather tool call card - Weather station style with live data display
 */
function WeatherToolCallCard({
  call,
  result,
  state,
}: {
  call: ToolCallFromTool<typeof getWeather>;
  result?: ToolMessage;
  state: ToolCallState;
}) {
  const isLoading = state === "pending";
  const parsedResult = parseToolResult(result);
  const isError = parsedResult.status === "error";
  const weather = !isError ? parseWeatherContent(parsedResult.content) : null;

  return (
    <div className="relative overflow-hidden rounded-xl animate-fade-in">
      {/* Sky gradient background */}
      <div className="absolute inset-0 bg-linear-to-br from-sky-600 via-sky-500 to-indigo-600" />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.15),transparent_50%)]" />

      <div className="relative p-4">
        {/* Location header */}
        <div className="flex items-center gap-2 text-white/80 text-xs mb-3">
          <MapPin className="w-3 h-3" />
          <span className="font-medium">{call.args.location}</span>
          {isLoading && (
            <Loader2 className="w-3 h-3 animate-spin ml-auto" />
          )}
        </div>

        {isError ? (
          <div className="bg-red-500/20 backdrop-blur-sm rounded-lg p-3 text-red-200 text-sm border border-red-400/30">
            {parsedResult.content}
          </div>
        ) : weather ? (
          <div className="flex items-start justify-between">
            {/* Left: Icon and condition */}
            <div className="flex flex-col items-start">
              {getWeatherIcon(weather.condition)}
              <span className="text-white/90 text-xs mt-1 font-medium">
                {weather.condition}
              </span>
            </div>

            {/* Right: Temperature */}
            <div className="text-right">
              <div className="text-4xl font-light text-white tracking-tight">
                {weather.temperature}
              </div>
              {/* Stats row */}
              <div className="flex gap-3 mt-2 text-white/70 text-xs">
                <div className="flex items-center gap-1">
                  <Wind className="w-3 h-3" />
                  <span>{weather.wind}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Droplets className="w-3 h-3" />
                  <span>{weather.humidity}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-4">
            <div className="flex flex-col items-center gap-2 text-white/60">
              <Cloud className="w-8 h-8 animate-pulse" />
              <span className="text-xs">Fetching weather...</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Parse calculator result to get expression and answer
 */
function parseCalculatorResult(content: string | undefined): {
  expression: string;
  result: string;
} | null {
  if (!content) return null;
  
  // Try to parse as JSON first (from the branching-chat agent)
  try {
    const parsed = JSON.parse(content);
    if (parsed.expression && parsed.result !== undefined) {
      return { 
        expression: parsed.expression, 
        result: String(parsed.result) 
      };
    }
  } catch {
    // Not JSON, try regex pattern
  }
  
  // Try "expression = result" pattern
  const match = content.match(/(.+)\s*=\s*(.+)/);
  if (!match) return null;
  return { expression: match[1].trim(), result: match[2].trim() };
}

/**
 * Calculator tool call card - Retro LCD calculator display
 */
function CalculatorToolCallCard({
  call,
  result,
  state,
}: {
  call: ToolCallFromTool<typeof calculate>;
  result?: ToolMessage;
  state: ToolCallState;
}) {
  const isLoading = state === "pending";
  const calcResult = parseCalculatorResult(result?.content as string | undefined);
  const isError = calcResult === null && result != null;

  return (
    <div className="rounded-xl bg-linear-to-b from-neutral-700 to-neutral-800 p-1 animate-fade-in shadow-lg">
      {/* Calculator body */}
      <div className="rounded-lg bg-linear-to-b from-neutral-800 to-neutral-900 p-3">
        {/* Brand label */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Calculator className="w-3 h-3 text-neutral-500" />
            <span className="text-[10px] text-neutral-500 font-medium tracking-widest uppercase">
              LangGraph
            </span>
          </div>
          {isLoading && (
            <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
          )}
        </div>

        {/* LCD Display */}
        <div className="bg-[#1a2f1a] rounded-md p-3 border border-[#0f1f0f] shadow-inner">
          {isError ? (
            <div className="font-mono text-red-400 text-sm">
              ERR: Could not calculate
            </div>
          ) : (
            <>
              {/* Expression row */}
              <div className="text-[#3a5f3a] font-mono text-xs text-right mb-1 h-4 overflow-hidden">
                {call.args.expression ?? ""}
              </div>
              {/* Result row */}
              <div className="flex items-center justify-end gap-2">
                {calcResult && (
                  <Equal className="w-3 h-3 text-[#4a7f4a]" />
                )}
                <span
                  className="font-mono text-2xl font-bold tracking-wider"
                  style={{
                    color: "#7fff7f",
                    textShadow: "0 0 10px rgba(127, 255, 127, 0.5)",
                  }}
                >
                  {calcResult?.result ?? (isLoading ? "..." : "0")}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Decorative button hints */}
        <div className="flex justify-end gap-1 mt-2">
          {["÷", "×", "−", "+"].map((op) => (
            <div
              key={op}
              className="w-5 h-5 rounded bg-neutral-700/50 flex items-center justify-center text-neutral-500 text-xs"
            >
              {op}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Note tool call card - Sticky note / pinned paper aesthetic
 */
function NoteToolCallCard({
  call,
  result,
  state,
}: {
  call: ToolCallFromTool<typeof takeNote>;
  result?: ToolMessage;
  state: ToolCallState;
}) {
  const isLoading = state === "pending";
  const parsedResult = parseToolResult(result);
  const isError = parsedResult.status === "error";

  return (
    <div className="relative animate-fade-in">
      {/* Push pin */}
      <div className="absolute -top-1 left-1/2 -translate-x-1/2 z-10">
        <div className="w-4 h-4 rounded-full bg-linear-to-br from-red-400 to-red-600 shadow-md border border-red-700/50 flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-red-300/50" />
        </div>
        <div className="w-0.5 h-2 bg-neutral-600 mx-auto -mt-0.5" />
      </div>

      {/* Note paper */}
      <div
        className="mt-2 rounded-sm shadow-lg"
        style={{
          background: "linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)",
          transform: "rotate(-1deg)",
        }}
      >
        {/* Lined paper effect */}
        <div
          className="p-4 pt-5"
          style={{
            backgroundImage:
              "repeating-linear-gradient(transparent, transparent 23px, #d4a574 24px)",
            backgroundPosition: "0 12px",
          }}
        >
          {/* Title */}
          <div className="flex items-start justify-between mb-2">
            <h4
              className="font-semibold text-amber-900 text-sm"
              style={{ fontFamily: "Georgia, serif" }}
            >
              {call.args.title ?? "Untitled Note"}
            </h4>
            {isLoading ? (
              <Loader2 className="w-3 h-3 animate-spin text-amber-700" />
            ) : !isError ? (
              <Check className="w-3 h-3 text-emerald-600" />
            ) : null}
          </div>

          {/* Content */}
          {isError ? (
            <p className="text-red-700 text-xs">{parsedResult.content}</p>
          ) : (
            <p
              className="text-amber-800 text-sm leading-6"
              style={{ fontFamily: "Georgia, serif" }}
            >
              {call.args.content ?? (result ? parsedResult.content : "Writing...")}
            </p>
          )}

          {/* Decorative corner fold */}
          <div
            className="absolute bottom-0 right-0 w-6 h-6"
            style={{
              background:
                "linear-gradient(135deg, transparent 50%, #d4a574 50%)",
            }}
          />
        </div>
      </div>

      {/* Shadow underneath */}
      <div
        className="absolute -bottom-1 left-2 right-2 h-2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, transparent 70%)",
        }}
      />
    </div>
  );
}

/**
 * Parse fact result to get topic and fact
 */
function parseFactResult(content: string): {
  topic: string;
  fact: string;
} | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.topic && parsed.fact) {
      return { topic: parsed.topic, fact: parsed.fact };
    }
  } catch {
    // Try to extract from plain text
    const match = content.match(/Topic:\s*(.+?)\s*Fact:\s*(.+)/i);
    if (match) {
      return { topic: match[1], fact: match[2] };
    }
  }
  return null;
}

/**
 * Fact tool call card - Minimal trivia card
 */
function FactToolCallCard({
  call,
  result,
  state,
}: {
  call: ToolCallFromTool<typeof getFact>;
  result?: ToolMessage;
  state: ToolCallState;
}) {
  const isLoading = state === "pending";
  const parsedResult = parseToolResult(result);
  const isError = parsedResult.status === "error";

  let factData: { topic: string; fact: string } | null = null;
  if (!isError && result) {
    factData = parseFactResult(result.content as string);
  }

  const topic = factData?.topic ?? call.args.topic ?? "trivia";
  const topicIcon = topic.toLowerCase().includes("science")
    ? <FlaskConical className="w-4 h-4" />
    : topic.toLowerCase().includes("history")
      ? <Landmark className="w-4 h-4" />
      : topic.toLowerCase().includes("nature")
        ? <TreePine className="w-4 h-4" />
        : <Lightbulb className="w-4 h-4" />;

  return (
    <div className="bg-neutral-900 rounded-lg p-4 border border-neutral-800 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
          {topicIcon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white">Did you know?</div>
          <div className="text-xs text-neutral-500 capitalize">{topic}</div>
        </div>
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
        ) : !isError ? (
          <Check className="w-4 h-4 text-green-400" />
        ) : null}
      </div>

      {/* Content */}
      {isError ? (
        <div className="text-sm text-red-400">{parsedResult.content}</div>
      ) : factData ? (
        <p className="text-sm text-neutral-300 leading-relaxed">
          {factData.fact}
        </p>
      ) : (
        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <Lightbulb className="w-4 h-4 animate-pulse" />
          <span>Finding a fact...</span>
        </div>
      )}
    </div>
  );
}