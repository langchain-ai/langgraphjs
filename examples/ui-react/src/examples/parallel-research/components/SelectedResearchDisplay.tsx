import type { ResearchConfig } from "../types";

/**
 * Selected research display
 */
export function SelectedResearchDisplay({
  config,
  content,
}: {
  config: ResearchConfig;
  content: string;
}) {
  return (
    <div className="mt-6 animate-fade-in">
      <div className="p-1 rounded-2xl bg-linear-to-r from-brand-accent/20 via-transparent to-brand-dark/20">
        <div className="p-6 rounded-xl bg-neutral-900 border border-neutral-800">
          <div className="flex items-center gap-3 mb-4">
            <div
              className={`
                w-10 h-10 rounded-xl flex items-center justify-center
                ${config.iconBg} ${config.accentColor}
              `}
            >
              {config.icon}
            </div>
            <div>
              <p className="text-xs text-neutral-500 uppercase tracking-wider">
                Your Selection
              </p>
              <h3 className={`font-semibold ${config.accentColor}`}>
                {config.name} Research
              </h3>
            </div>
          </div>
          <div className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
