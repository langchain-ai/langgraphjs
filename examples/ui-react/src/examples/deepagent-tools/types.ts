/**
 * Subagent types available in this example
 */
export type SubagentType = "researcher" | "data-analyst" | "content-writer";

/**
 * Configuration for each subagent type
 */
export interface SubagentConfig {
  icon: string;
  title: string;
  gradient: string;
  borderColor: string;
  bgColor: string;
  iconBg: string;
  accentColor: string;
}

export const SUBAGENT_CONFIGS: Record<SubagentType, SubagentConfig> = {
  researcher: {
    icon: "search",
    title: "Researcher",
    gradient: "from-blue-500/20 to-cyan-600/20",
    borderColor: "border-blue-500/40",
    bgColor: "bg-blue-950/30",
    iconBg: "bg-blue-500/20",
    accentColor: "text-blue-400",
  },
  "data-analyst": {
    icon: "chart",
    title: "Data Analyst",
    gradient: "from-purple-500/20 to-violet-600/20",
    borderColor: "border-purple-500/40",
    bgColor: "bg-purple-950/30",
    iconBg: "bg-purple-500/20",
    accentColor: "text-purple-400",
  },
  "content-writer": {
    icon: "pen",
    title: "Content Writer",
    gradient: "from-rose-500/20 to-pink-600/20",
    borderColor: "border-rose-500/40",
    bgColor: "bg-rose-950/30",
    iconBg: "bg-rose-500/20",
    accentColor: "text-rose-400",
  },
};
