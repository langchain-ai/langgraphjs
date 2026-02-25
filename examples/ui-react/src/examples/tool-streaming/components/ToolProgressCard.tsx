import { Building2, Check, Loader2, Map, Plane } from "lucide-react";
import type { ToolProgress } from "@langchain/langgraph-sdk";

const TOOL_CONFIG: Record<
  string,
  {
    icon: typeof Plane;
    label: string;
    gradient: string;
    barGradient: string;
    accentColor: string;
    bgColor: string;
  }
> = {
  search_flights: {
    icon: Plane,
    label: "Searching Flights",
    gradient: "from-sky-950/60 to-blue-950/40",
    barGradient: "from-sky-500 to-blue-500",
    accentColor: "text-sky-400",
    bgColor: "bg-sky-500/20",
  },
  check_hotel_availability: {
    icon: Building2,
    label: "Checking Hotels",
    gradient: "from-amber-950/60 to-orange-950/40",
    barGradient: "from-amber-500 to-orange-500",
    accentColor: "text-amber-400",
    bgColor: "bg-amber-500/20",
  },
  plan_itinerary: {
    icon: Map,
    label: "Planning Itinerary",
    gradient: "from-emerald-950/60 to-teal-950/40",
    barGradient: "from-emerald-500 to-teal-500",
    accentColor: "text-emerald-400",
    bgColor: "bg-emerald-500/20",
  },
};

const DEFAULT_CONFIG = {
  icon: Loader2,
  label: "Processing",
  gradient: "from-neutral-950/60 to-neutral-900/40",
  barGradient: "from-neutral-500 to-neutral-400",
  accentColor: "text-neutral-400",
  bgColor: "bg-neutral-500/20",
};

/** Shape of streamed progress data yielded by the tool-streaming agent tools */
export interface ToolProgressStreamData {
  message?: string;
  progress?: number;
  completed?: string[];
}

interface ToolProgressCardProps {
  toolProgress: ToolProgress;
}

function getProgressData(data: unknown): ToolProgressStreamData | undefined {
  if (data == null || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  return {
    message: typeof d.message === "string" ? d.message : undefined,
    progress: typeof d.progress === "number" ? d.progress : undefined,
    completed: Array.isArray(d.completed)
      ? (d.completed as string[])
      : undefined,
  };
}

export function ToolProgressCard({ toolProgress }: ToolProgressCardProps) {
  const config = TOOL_CONFIG[toolProgress.name] ?? DEFAULT_CONFIG;
  const Icon = config.icon;
  const data = getProgressData(toolProgress.data);
  const progress = Math.min(
    100,
    Math.max(0, Math.round((data?.progress ?? 0) * 100))
  );
  const message = data?.message ?? "Starting...";
  const completed = data?.completed ?? [];

  return (
    <div className="animate-fade-in">
      <div
        className={`bg-linear-to-br ${config.gradient} border border-white/10 rounded-xl p-4 backdrop-blur-sm`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div
            className={`w-9 h-9 rounded-lg ${config.bgColor} flex items-center justify-center`}
          >
            <Icon className={`w-5 h-5 ${config.accentColor} animate-pulse`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium text-white">{config.label}</h4>
              <Loader2
                className={`w-3.5 h-3.5 ${config.accentColor} animate-spin`}
              />
            </div>
            <p className={`text-xs ${config.accentColor}/70 truncate`}>
              {message}
            </p>
          </div>
          <div className="text-right">
            <span className={`text-lg font-bold ${config.accentColor}`}>
              {progress}%
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="relative h-2 bg-black/40 rounded-full overflow-hidden mb-3">
          <div
            className={`absolute inset-y-0 left-0 bg-linear-to-r ${config.barGradient} rounded-full transition-all duration-500 ease-out`}
            style={{ width: `${progress}%` }}
          />
          <div
            className="absolute inset-y-0 left-0 bg-linear-to-r from-transparent via-white/20 to-transparent rounded-full animate-shimmer"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Completed steps */}
        {completed.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {completed.map((step, i) => (
              <div
                key={i}
                className="flex items-center gap-2 text-xs text-white/70 animate-fade-in"
              >
                <Check className={`w-3 h-3 ${config.accentColor} shrink-0`} />
                <span className="truncate">{step}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
