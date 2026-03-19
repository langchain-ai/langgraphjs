/* eslint-disable import/no-extraneous-dependencies */
/**
 * Fixtures imported by Vitest browser tests. Only type-only imports from
 * deepagents — value imports would pull its langchain graph stack into Vite's
 * browser pre-bundle and fail (see langchain `browser` export).
 */
import type { DeepAgent } from "deepagents";
import { tool } from "langchain";
import { z } from "zod/v4";

export const getLocationTool = tool({
  name: "get_location",
  description: "Get the user's current GPS location",
  schema: z.object({ highAccuracy: z.boolean().optional() }),
});

export type DeepAgentGraph = DeepAgent;
