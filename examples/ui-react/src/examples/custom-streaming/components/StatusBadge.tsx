import { CheckCircle2, XCircle, Sparkles } from "lucide-react";
import type { StatusData } from "../types";

interface StatusBadgeProps {
  data: StatusData;
}

/**
 * StatusBadge displays completion or error status from streaming events.
 * Shows a compact badge with icon and message.
 */
export function StatusBadge({ data }: StatusBadgeProps) {
  const isComplete = data.status === "complete";

  return (
    <div className="animate-fade-in">
      <div
        className={`inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl border backdrop-blur-sm ${
          isComplete
            ? "bg-emerald-950/40 border-emerald-500/30"
            : "bg-red-950/40 border-red-500/30"
        }`}
      >
        <div
          className={`w-7 h-7 rounded-lg flex items-center justify-center ${
            isComplete ? "bg-emerald-500/20" : "bg-red-500/20"
          }`}
        >
          {isComplete ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          ) : (
            <XCircle className="w-4 h-4 text-red-400" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`text-sm font-medium ${
              isComplete ? "text-emerald-300" : "text-red-300"
            }`}
          >
            {data.message}
          </span>
          {isComplete && (
            <Sparkles className="w-3.5 h-3.5 text-emerald-400/60" />
          )}
        </div>
      </div>
    </div>
  );
}
