import type { ComponentType } from "react";

import type { Transport } from "./api";
import { BranchingChatView } from "./views/BranchingChatView";
import { CustomChannelView } from "./views/CustomChannelView";
import { DeepAgentView } from "./views/DeepAgentView";
import { FanOutView } from "./views/FanOutView";
import { HeadlessToolsView } from "./views/HeadlessToolsView";
import { HumanInTheLoopView } from "./views/HumanInTheLoopView";
import { NestedStateGraphView } from "./views/NestedStateGraphView";
import { ReactAgentView } from "./views/ReactAgentView";
import { ReasoningAgentView } from "./views/ReasoningAgentView";
import { SummarizationAgentView } from "./views/SummarizationAgentView";
import { ToolStreamingView } from "./views/ToolStreamingView";

export type ExampleCategory =
  | "agents"
  | "langgraph"
  | "middleware"
  | "advanced";

export interface ExampleDefinition {
  id: string;
  title: string;
  description: string;
  category: ExampleCategory;
  assistantId: string;
  component: ComponentType<{ transport: Transport }>;
}

export const CATEGORIES: Record<
  ExampleCategory,
  { title: string; description: string }
> = {
  agents: {
    title: "Agents",
    description: "Tool-calling and agentic workflows",
  },
  langgraph: {
    title: "LangGraph",
    description: "Graph state, branching, and reconnection",
  },
  middleware: {
    title: "Middleware",
    description: "Runtime behavior layered onto agents",
  },
  advanced: {
    title: "Advanced",
    description: "Custom streams and specialized UI surfaces",
  },
};

export const EXAMPLES: ExampleDefinition[] = [
  {
    id: "nested-stategraph",
    title: "Nested StateGraph",
    description: "Top-level graph with two compiled subgraphs rendered live.",
    category: "langgraph",
    assistantId: "nested-stategraph",
    component: NestedStateGraphView,
  },
  {
    id: "react-agent",
    title: "ReAct Agent",
    description: "createAgent runtime with streaming tool calls.",
    category: "agents",
    assistantId: "react-agent",
    component: ReactAgentView,
  },
  {
    id: "branching-chat",
    title: "Branching Chat",
    description: "Edit or regenerate messages from earlier checkpoints.",
    category: "langgraph",
    assistantId: "branching-chat",
    component: BranchingChatView,
  },
  {
    id: "human-in-the-loop",
    title: "Human in the Loop",
    description: "Approve, edit, or reject a sensitive tool call.",
    category: "agents",
    assistantId: "human-in-the-loop",
    component: HumanInTheLoopView,
  },
  {
    id: "headless-tools",
    title: "Headless Tools",
    description: "Browser memory and geolocation through client-side tools.",
    category: "agents",
    assistantId: "headless-tools",
    component: HeadlessToolsView,
  },
  {
    id: "deep-agent",
    title: "Deep Agent",
    description: "Four poetry subagents running in parallel.",
    category: "agents",
    assistantId: "deep-agent",
    component: DeepAgentView,
  },
  {
    id: "summarization-agent",
    title: "Summarization",
    description: "Conversation summarization middleware under token pressure.",
    category: "middleware",
    assistantId: "summarization-agent",
    component: SummarizationAgentView,
  },
  {
    id: "reasoning-agent",
    title: "Reasoning Agent",
    description: "Reasoning-oriented prompts with a dedicated reasoning view.",
    category: "advanced",
    assistantId: "reasoning-agent",
    component: ReasoningAgentView,
  },
  {
    id: "tool-streaming",
    title: "Tool Streaming",
    description: "Generator tools that emit progress while they run.",
    category: "advanced",
    assistantId: "tool-streaming",
    component: ToolStreamingView,
  },
  {
    id: "fan-out",
    title: "Fan-out (100+)",
    description: "Hundred+ subagents; content streams load lazily.",
    category: "advanced",
    assistantId: "fan-out",
    component: FanOutView,
  },
  {
    id: "custom-channel",
    title: "Custom Stream Channel",
    description: "Server-side transformer rendered from one custom channel.",
    category: "advanced",
    assistantId: "research-timeline",
    component: CustomChannelView,
  },
];

export const DEFAULT_EXAMPLE_ID = EXAMPLES[0].id;

export type ExampleId = (typeof EXAMPLES)[number]["id"];

export const getExample = (id: string | null | undefined) =>
  EXAMPLES.find((example) => example.id === id);

export const getExamplesByCategory = () =>
  EXAMPLES.reduce(
    (groups, example) => {
      groups[example.category] = [...(groups[example.category] ?? []), example];
      return groups;
    },
    {} as Record<ExampleCategory, ExampleDefinition[]>
  );
