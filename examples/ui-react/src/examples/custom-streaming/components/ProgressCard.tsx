import { Activity, CheckCircle2, Loader2 } from "lucide-react";
import type { ProgressData } from "../types";

interface ProgressCardProps {
  data: ProgressData;
  isComplete?: boolean;
}

/**
 * ProgressCard displays streaming progress updates from the data analysis tool.
 * Shows a progress bar, current step, and status message.
 */
export function ProgressCard({ data, isComplete = false }: ProgressCardProps) {
  const progressPercent = Math.min(100, Math.max(0, data.progress));

  return (
    <div className="animate-fade-in">
      <div className="bg-linear-to-br from-indigo-950/60 to-violet-950/40 border border-indigo-500/30 rounded-xl p-4 backdrop-blur-sm">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 rounded-lg bg-indigo-500/20 flex items-center justify-center">
            {isComplete ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            ) : (
              <Activity className="w-5 h-5 text-indigo-400 animate-pulse" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium text-white">Data Analysis</h4>
              {!isComplete && (
                <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
              )}
            </div>
            <p className="text-xs text-indigo-300/70 truncate">
              Step {data.currentStep} of {data.totalSteps}
            </p>
          </div>
          <div className="text-right">
            <span className="text-lg font-bold text-indigo-300">
              {progressPercent}%
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="relative h-2 bg-indigo-950/80 rounded-full overflow-hidden mb-3">
          <div
            className="absolute inset-y-0 left-0 bg-linear-to-r from-indigo-500 to-violet-500 rounded-full transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
          {!isComplete && (
            <div
              className="absolute inset-y-0 left-0 bg-linear-to-r from-transparent via-white/20 to-transparent rounded-full animate-shimmer"
              style={{ width: `${progressPercent}%` }}
            />
          )}
        </div>

        {/* Current step message */}
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${
              isComplete
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-indigo-500/20 text-indigo-300"
            }`}
          >
            {data.step}
          </span>
          <span className="text-indigo-200/80">{data.message}</span>
        </div>
      </div>
    </div>
  );
}
