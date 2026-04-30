/* eslint-disable import/no-extraneous-dependencies */
/**
 * Browser-side tool schema used by `HeadlessToolStream`. Pulling
 * `langchain/tool` directly at the top of a test component would
 * drag the node-only langgraph runtime into Vite's browser
 * pre-bundle. Only the schema is needed in the browser, the graph
 * definition lives on the mock server (see
 * `../fixtures/headless-tool-graph.ts`).
 */
import { tool } from "langchain";
import { z } from "zod/v4";

export const getLocationTool = tool({
  name: "get_location",
  description: "Get the user's current GPS location",
  schema: z.object({ highAccuracy: z.boolean().optional() }),
});
