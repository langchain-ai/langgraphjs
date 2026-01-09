import { GitFork } from "lucide-react";

/**
 * Topic display bar
 */
export function TopicBar({ topic }: { topic: string }) {
  return (
    <div className="mb-6 p-4 rounded-xl bg-linear-to-r from-neutral-900 to-neutral-800 border border-neutral-700">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-dark/40 border border-brand-accent/30 flex items-center justify-center">
          <GitFork className="w-5 h-5 text-brand-accent" />
        </div>
        <div>
          <p className="text-xs text-neutral-500 uppercase tracking-wider">
            Research Topic
          </p>
          <p className="text-white font-medium">{topic}</p>
        </div>
      </div>
    </div>
  );
}
