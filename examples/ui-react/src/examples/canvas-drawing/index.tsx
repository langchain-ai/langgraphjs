import { useCallback, useEffect, useRef, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  Paintbrush,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Download,
  Trash2,
  Square,
  Circle,
  Minus,
  Type,
  Spline,
  Info,
  BookMarked,
  Move,
  Layers,
  Blend,
  SlidersHorizontal,
  Ellipsis,
  Star,
} from "lucide-react";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream, type ToolEvent } from "@langchain/langgraph-sdk/react";
import type {
  ToolCallWithResult,
  DefaultToolCall,
} from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { LoadingIndicator } from "../../components/Loading";

import type { agent } from "./agent";
import {
  setCanvasContext,
  canvasGetInfo,
  canvasClear,
  canvasSetStyle,
  canvasDrawRect,
  canvasDrawCircle,
  canvasDrawLine,
  canvasDrawText,
  canvasDrawPath,
  canvasSaveRestore,
  canvasTransform,
  canvasSetGradient,
  canvasDrawEllipse,
  canvasDrawPolygon,
  canvasSetLineDash,
  canvasSetBlendMode,
  canvasSetFilter,
} from "./toolsImpl";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;

const SUGGESTIONS = [
  "Paint a neon-lit city skyline at night with glowing reflections",
  "Draw a starry night sky with a glowing moon and silhouetted mountains",
  "Create a geometric mandala with star shapes and gradient colours",
  "Draw a vibrant sunset over the ocean with watercolour washes",
  "Paint a pelican on a bicycle",
  "Create a retro synthwave landscape with a grid and sun",
];

// Map tool names to Lucide icons
const TOOL_ICONS: Record<string, React.ReactNode> = {
  canvas_get_info: <Info className="w-4 h-4" />,
  canvas_clear: <Trash2 className="w-4 h-4" />,
  canvas_set_style: <Paintbrush className="w-4 h-4" />,
  canvas_set_gradient: <Layers className="w-4 h-4" />,
  canvas_set_line_dash: <Minus className="w-4 h-4" />,
  canvas_set_blend_mode: <Blend className="w-4 h-4" />,
  canvas_set_filter: <SlidersHorizontal className="w-4 h-4" />,
  canvas_draw_rect: <Square className="w-4 h-4" />,
  canvas_draw_circle: <Circle className="w-4 h-4" />,
  canvas_draw_ellipse: <Ellipsis className="w-4 h-4" />,
  canvas_draw_polygon: <Star className="w-4 h-4" />,
  canvas_draw_line: <Minus className="w-4 h-4" />,
  canvas_draw_text: <Type className="w-4 h-4" />,
  canvas_draw_path: <Spline className="w-4 h-4" />,
  canvas_save_restore: <BookMarked className="w-4 h-4" />,
  canvas_transform: <Move className="w-4 h-4" />,
};

const TOOL_LABELS: Record<string, string> = {
  canvas_get_info: "Getting canvas info",
  canvas_clear: "Clearing canvas",
  canvas_set_style: "Setting style",
  canvas_set_gradient: "Setting gradient",
  canvas_set_line_dash: "Setting line dash",
  canvas_set_blend_mode: "Setting blend mode",
  canvas_set_filter: "Applying filter",
  canvas_draw_rect: "Drawing rectangle",
  canvas_draw_circle: "Drawing circle",
  canvas_draw_ellipse: "Drawing ellipse",
  canvas_draw_polygon: "Drawing polygon / star",
  canvas_draw_line: "Drawing line",
  canvas_draw_text: "Drawing text",
  canvas_draw_path: "Drawing path",
  canvas_save_restore: "Saving / restoring state",
  canvas_transform: "Applying transform",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a brief human-readable summary of the key tool arguments. */
function toolArgSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "canvas_clear":
      return args.color ? `background: ${args.color}` : "transparent";
    case "canvas_set_style": {
      const parts: string[] = [];
      if (args.fillColor) parts.push(`fill: ${args.fillColor}`);
      if (args.strokeColor) parts.push(`stroke: ${args.strokeColor}`);
      if (args.lineWidth) parts.push(`width: ${args.lineWidth}px`);
      if (args.font) parts.push(`font: ${args.font}`);
      return parts.join(" · ") || "no changes";
    }
    case "canvas_set_gradient":
      return `${args.type} gradient (${
        (args.stops as { color: string }[])?.length ?? 0
      } stops)`;
    case "canvas_draw_rect":
      return `(${args.x}, ${args.y}) ${args.width}×${args.height}px`;
    case "canvas_draw_circle":
      return `centre (${args.cx}, ${args.cy}) r=${args.radius}`;
    case "canvas_draw_line":
      return `(${args.x1},${args.y1}) → (${args.x2},${args.y2})`;
    case "canvas_draw_text":
      return `"${String(args.text).slice(0, 40)}"`;
    case "canvas_draw_path":
      return `${(args.commands as unknown[])?.length ?? 0} commands`;
    case "canvas_save_restore":
      return String(args.action);
    case "canvas_draw_ellipse":
      return `(${args.cx}, ${args.cy}) rx=${args.radiusX} ry=${args.radiusY}${
        args.rotation ? ` rot=${args.rotation}°` : ""
      }`;
    case "canvas_draw_polygon":
      return args.innerRadius
        ? `${args.sides}-point star r=${args.outerRadius}`
        : `${args.sides}-gon r=${args.outerRadius}`;
    case "canvas_set_line_dash":
      return (args.segments as number[])?.length
        ? `[${(args.segments as number[]).join(",")}]`
        : "solid";
    case "canvas_set_blend_mode":
      return String(args.mode);
    case "canvas_set_filter":
      return String(args.filter);
    case "canvas_transform":
      if (args.action === "translate") return `translate(${args.x}, ${args.y})`;
      if (args.action === "rotate") return `rotate(${args.angle}°)`;
      if (args.action === "scale")
        return `scale(${args.scaleX}, ${args.scaleY})`;
      return String(args.action);
    default:
      return "";
  }
}

/** Returns the primary colour argument for swatch preview (if any). */
function primaryColor(
  name: string,
  args: Record<string, unknown>
): string | undefined {
  if (name === "canvas_clear" && args.color) return String(args.color);
  if (name === "canvas_set_style") {
    return args.fillColor
      ? String(args.fillColor)
      : args.strokeColor
      ? String(args.strokeColor)
      : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Color swatch
// ---------------------------------------------------------------------------

function ColorSwatch({ color }: { color?: string }) {
  if (!color) return null;
  return (
    <span
      className="inline-block w-3 h-3 rounded-sm border border-white/20 shrink-0 align-middle"
      style={{ backgroundColor: color }}
      title={color}
    />
  );
}

// ---------------------------------------------------------------------------
// Live browser-tool status bar (while executing)
// ---------------------------------------------------------------------------

function DrawingStatus({ events }: { events: ToolEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {events.map((event, idx) => (
        <div
          key={idx}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
            event.phase === "start"
              ? "bg-blue-500/10 border border-blue-500/20 text-blue-400"
              : event.phase === "success"
              ? "bg-green-500/10 border border-green-500/20 text-green-400"
              : "bg-red-500/10 border border-red-500/20 text-red-400"
          }`}
        >
          {event.phase === "start" ? (
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
          ) : event.phase === "success" ? (
            <CheckCircle2 className="w-3 h-3 shrink-0" />
          ) : (
            <AlertCircle className="w-3 h-3 shrink-0" />
          )}
          <span className="flex items-center gap-1.5">
            {TOOL_ICONS[event.name] || <Paintbrush className="w-3 h-3" />}
            {TOOL_LABELS[event.name] || event.name}
            {event.phase === "start"
              ? "…"
              : event.phase === "success"
              ? event.duration
                ? ` (${event.duration}ms)`
                : ""
              : `: ${event.error?.message}`}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool call card (rendered in the message list)
// ---------------------------------------------------------------------------

function CanvasToolCallCard({
  toolCall,
}: {
  toolCall: ToolCallWithResult<DefaultToolCall>;
}) {
  const { call, state } = toolCall;
  const isLoading = state === "pending";
  const icon = TOOL_ICONS[call.name] || <Paintbrush className="w-4 h-4" />;
  const label =
    TOOL_LABELS[call.name] ||
    call.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const summary = toolArgSummary(
    call.name,
    call.args as Record<string, unknown>
  );
  const swatch = primaryColor(call.name, call.args as Record<string, unknown>);

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-neutral-900 border border-neutral-800 text-sm animate-fade-in">
      <div className="w-7 h-7 rounded-md bg-blue-500/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-white font-medium">{label}</span>
        {summary && (
          <span className="ml-2 text-neutral-500 text-xs truncate">
            {summary}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {swatch && <ColorSwatch color={swatch} />}
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas toolbar
// ---------------------------------------------------------------------------

interface CanvasToolbarProps {
  isDrawing: boolean;
  onClear: () => void;
  onDownload: () => void;
}

function CanvasToolbar({ isDrawing, onClear, onDownload }: CanvasToolbarProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800">
      <div className="flex items-center gap-2 text-sm text-neutral-400">
        <Paintbrush className="w-4 h-4" />
        <span className="font-medium">Canvas</span>
        <span className="text-neutral-600 text-xs">800 × 500 px</span>
        {isDrawing && (
          <span className="flex items-center gap-1.5 text-blue-400 text-xs ml-2">
            <Loader2 className="w-3 h-3 animate-spin" />
            Drawing…
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onClear}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors border border-transparent hover:border-neutral-700"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Clear
        </button>
        <button
          onClick={onDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors border border-transparent hover:border-neutral-700"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggestion pills (shown before first message)
// ---------------------------------------------------------------------------

function SuggestionPills({
  onSelect,
}: {
  onSelect: (suggestion: string) => void;
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-xs text-neutral-500 mb-2">Try asking:</p>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onSelect(s)}
            className="px-2.5 py-1 rounded-full bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 text-neutral-400 hover:text-white text-xs transition-colors cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Check if a message has visible text content
// ---------------------------------------------------------------------------

function hasContent(message: Message): boolean {
  if (typeof message.content === "string") return message.content.trim() !== "";
  if (Array.isArray(message.content)) {
    return message.content.some(
      (c) => c.type === "text" && c.text.trim() !== ""
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CanvasDrawingAgent() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);

  // ── Initialise canvas & share context with headless tools ──────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_WIDTH * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    canvas.style.width = `${CANVAS_WIDTH}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;

    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    // Scale so that all tool coordinates are in logical (CSS) pixels
    ctx2d.scale(dpr, dpr);
    // Pass logical dimensions so canvas_get_info reports the correct
    // coordinate space to the LLM (not the enlarged physical backing store)
    setCanvasContext(ctx2d, CANVAS_WIDTH, CANVAS_HEIGHT);

    return () => setCanvasContext(null);
  }, []);

  // ── UI actions ─────────────────────────────────────────────────────────────
  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    ctx2d.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }, []);

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `canvas-drawing-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, []);

  // ── Stream ─────────────────────────────────────────────────────────────────
  const stream = useStream<typeof agent>({
    assistantId: "canvas-drawing",
    apiUrl: "http://localhost:2024",
    tools: [
      canvasGetInfo,
      canvasClear,
      canvasSetStyle,
      canvasDrawRect,
      canvasDrawCircle,
      canvasDrawLine,
      canvasDrawText,
      canvasDrawPath,
      canvasSaveRestore,
      canvasTransform,
      canvasSetGradient,
      canvasDrawEllipse,
      canvasDrawPolygon,
      canvasSetLineDash,
      canvasSetBlendMode,
      canvasSetFilter,
    ],
    onTool: (event) => {
      if (event.phase === "start") {
        setIsDrawing(true);
        setToolEvents((prev) => [...prev, event]);
      } else {
        setToolEvents((prev) =>
          prev.map((e) =>
            e.name === event.name && e.phase === "start" ? event : e
          )
        );
        setTimeout(() => {
          setIsDrawing(false);
          setToolEvents((prev) => prev.filter((e) => e.name !== event.name));
        }, 1500);
      }
    },
  });

  const { scrollRef, contentRef } = useStickToBottom();
  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  return (
    <div className="h-full flex flex-col">
      {/* ── Canvas panel ─────────────────────────────────────────────────── */}
      <div className="shrink-0 border-b border-neutral-800 bg-black">
        <CanvasToolbar
          isDrawing={isDrawing}
          onClear={handleClear}
          onDownload={handleDownload}
        />
        {/* Checkerboard background shows transparent areas */}
        <div
          className="flex items-center justify-center py-3 px-4"
          style={{
            background:
              "repeating-conic-gradient(#1a1a1a 0% 25%, #111 0% 50%) 0 0 / 24px 24px",
          }}
        >
          <canvas
            ref={canvasRef}
            className="rounded-md shadow-2xl ring-1 ring-white/5"
            style={{
              maxWidth: "100%",
              imageRendering: "auto",
            }}
          />
        </div>
      </div>

      {/* ── Chat panel ───────────────────────────────────────────────────── */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto min-h-0">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-4">
          {!hasMessages ? (
            <SuggestionPills onSelect={handleSubmit} />
          ) : (
            <div className="flex flex-col gap-4">
              {stream.messages.map((message, idx) => {
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  // Render tool call cards instead of raw AI messages
                  if (toolCalls.length > 0) {
                    return (
                      <div
                        key={message.id ?? idx}
                        className="flex flex-col gap-1.5"
                      >
                        {toolCalls.map((tc) => (
                          <CanvasToolCallCard key={tc.id} toolCall={tc} />
                        ))}
                      </div>
                    );
                  }

                  if (!hasContent(message)) return null;
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Live drawing status */}
              <DrawingStatus events={toolEvents} />

              {/* Spinner while the LLM is thinking */}
              {stream.isLoading &&
                !stream.messages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                stream.toolCalls.length === 0 &&
                toolEvents.length === 0 && <LoadingIndicator />}
            </div>
          )}
        </div>
      </main>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {stream.error != null && (
        <div className="max-w-2xl mx-auto w-full px-4 pb-2">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {stream.error instanceof Error
              ? stream.error.message
              : "An error occurred"}
          </div>
        </div>
      )}

      {/* ── Input ────────────────────────────────────────────────────────── */}
      <MessageInput
        disabled={stream.isLoading}
        placeholder="Ask the AI to draw something…"
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register example
registerExample({
  id: "canvas-drawing",
  title: "Canvas Drawing",
  description:
    "AI artist that draws on an HTML5 canvas using headless tools — no eval",
  category: "agents",
  icon: "tool",
  ready: true,
  component: CanvasDrawingAgent,
});

export default CanvasDrawingAgent;
