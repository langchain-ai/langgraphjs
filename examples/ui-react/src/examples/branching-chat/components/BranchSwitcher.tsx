import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";

interface BranchSwitcherProps {
  branch: string | undefined;
  branchOptions: string[] | undefined;
  onSelect: (branch: string) => void;
}

/**
 * Component for navigating between conversation branches.
 * Shows prev/next controls when multiple branches exist at a fork point.
 */
export function BranchSwitcher({
  branch,
  branchOptions,
  onSelect,
}: BranchSwitcherProps) {
  if (!branchOptions || branchOptions.length <= 1 || !branch) {
    return null;
  }

  const index = branchOptions.indexOf(branch);
  const hasPrev = index > 0;
  const hasNext = index < branchOptions.length - 1;

  return (
    <div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-neutral-800/60 border border-neutral-700/50">
      <GitBranch className="w-3 h-3 text-purple-400" />
      <button
        type="button"
        disabled={!hasPrev}
        onClick={() => {
          const prevBranch = branchOptions[index - 1];
          if (prevBranch) onSelect(prevBranch);
        }}
        className="p-0.5 rounded hover:bg-neutral-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Previous branch"
      >
        <ChevronLeft className="w-3.5 h-3.5 text-neutral-300" />
      </button>
      <span className="text-xs text-neutral-400 font-medium min-w-[3ch] text-center">
        {index + 1}/{branchOptions.length}
      </span>
      <button
        type="button"
        disabled={!hasNext}
        onClick={() => {
          const nextBranch = branchOptions[index + 1];
          if (nextBranch) onSelect(nextBranch);
        }}
        className="p-0.5 rounded hover:bg-neutral-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Next branch"
      >
        <ChevronRight className="w-3.5 h-3.5 text-neutral-300" />
      </button>
    </div>
  );
}

