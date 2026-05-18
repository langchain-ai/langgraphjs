import { createDeepAgent, type DeepAgent } from "deepagents";

import {
  deepAnalystModel,
  deepOrchestratorModel,
  deepResearcherModel,
  queryDatabaseTool,
  searchWebTool,
} from "./shared.js";

export const graph = createDeepAgent({
  model: deepOrchestratorModel,
  subagents: [
    {
      name: "researcher",
      description: "Research specialist that searches the web for information.",
      systemPrompt: "You are a research specialist.",
      tools: [searchWebTool],
      model: deepResearcherModel,
    },
    {
      name: "data-analyst",
      description: "Data analysis expert that queries databases for insights.",
      systemPrompt: "You are a data analysis expert.",
      tools: [queryDatabaseTool],
      model: deepAnalystModel,
    },
  ],
  systemPrompt: "You are an AI coordinator that delegates tasks.",
}) as DeepAgent;
