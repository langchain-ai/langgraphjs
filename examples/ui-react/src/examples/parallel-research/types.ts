/**
 * Research content record type
 */
export type ResearchContents = {
  analytical: string;
  creative: string;
  practical: string;
};

export type ResearchId = keyof ResearchContents;

/**
 * Research model configuration for visual display
 */
export interface ResearchConfig {
  id: ResearchId;
  name: string;
  nodeName: string;
  icon: React.ReactNode;
  description: string;
  gradient: string;
  borderColor: string;
  bgColor: string;
  iconBg: string;
  accentColor: string;
}
