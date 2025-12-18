import {
  FileText,
  Archive,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { FileStatusData } from "../types";

interface FileOperationCardProps {
  data: FileStatusData;
}

const OPERATION_CONFIG: Record<
  FileStatusData["operation"],
  { icon: LucideIcon; label: string; gradient: string; border: string }
> = {
  read: {
    icon: FileText,
    label: "Reading",
    gradient: "from-sky-950/60 to-cyan-950/40",
    border: "border-sky-500/30",
  },
  compress: {
    icon: Archive,
    label: "Compressing",
    gradient: "from-amber-950/60 to-orange-950/40",
    border: "border-amber-500/30",
  },
  validate: {
    icon: ShieldCheck,
    label: "Validating",
    gradient: "from-emerald-950/60 to-teal-950/40",
    border: "border-emerald-500/30",
  },
  transform: {
    icon: RefreshCw,
    label: "Transforming",
    gradient: "from-purple-950/60 to-fuchsia-950/40",
    border: "border-purple-500/30",
  },
};

/**
 * FileOperationCard displays file processing status from streaming events.
 * Shows the filename, operation type, and current status with appropriate styling.
 */
export function FileOperationCard({ data }: FileOperationCardProps) {
  const config = OPERATION_CONFIG[data.operation];
  const Icon = config.icon;
  const isCompleted = data.status === "completed";
  const isError = data.status === "error";

  return (
    <div className="animate-fade-in">
      <div
        className={`bg-gradient-to-br ${config.gradient} border ${config.border} rounded-xl p-4 backdrop-blur-sm`}
      >
        <div className="flex items-center gap-3">
          {/* Icon */}
          <div className="w-10 h-10 rounded-lg bg-white/5 flex items-center justify-center">
            {isCompleted ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            ) : isError ? (
              <Icon className="w-5 h-5 text-red-400" />
            ) : (
              <Icon className="w-5 h-5 text-neutral-300 animate-pulse" />
            )}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-white truncate">
                {data.filename}
              </span>
              {!isCompleted && !isError && (
                <Loader2 className="w-3.5 h-3.5 text-neutral-400 animate-spin flex-shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-neutral-400">
                {config.label} file
              </span>
              {data.size && (
                <>
                  <span className="text-neutral-600">·</span>
                  <span className="text-xs text-neutral-500">{data.size}</span>
                </>
              )}
            </div>
          </div>

          {/* Status badge */}
          <div
            className={`px-2.5 py-1 rounded-md text-xs font-medium uppercase tracking-wide ${
              isCompleted
                ? "bg-emerald-500/20 text-emerald-300"
                : isError
                  ? "bg-red-500/20 text-red-300"
                  : "bg-white/10 text-neutral-300"
            }`}
          >
            {data.status}
          </div>
        </div>
      </div>
    </div>
  );
}

