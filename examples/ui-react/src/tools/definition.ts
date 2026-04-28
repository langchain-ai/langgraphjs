import { tool } from "langchain";
import { z } from "zod/v4";

export const memoryPut = tool({
  name: "memory_put",
  description:
    "Store a durable memory in the user's browser. Use for preferences, facts, and project context.",
  schema: z.object({
    key: z.string().describe("Stable key for the memory."),
    value: z.unknown().describe("JSON-serializable memory value."),
    tags: z.array(z.string()).optional().describe("Tags for retrieval."),
    ttlDays: z.number().optional().describe("Optional expiry in days."),
  }),
});

export const memoryGet = tool({
  name: "memory_get",
  description: "Retrieve one memory from the browser by key.",
  schema: z.object({
    key: z.string().describe("Memory key to retrieve."),
  }),
});

export const memoryList = tool({
  name: "memory_list",
  description: "List browser memories, optionally filtered by tag.",
  schema: z.object({
    tags: z.array(z.string()).optional().describe("Tags to filter by."),
    limit: z.number().optional().describe("Maximum number of memories."),
  }),
});

export const memorySearch = tool({
  name: "memory_search",
  description: "Search browser memories by key, value, or tag.",
  schema: z.object({
    query: z.string().describe("Search query."),
    tags: z.array(z.string()).optional().describe("Tags to filter by."),
    limit: z.number().optional().describe("Maximum number of results."),
  }),
});

export const memoryForget = tool({
  name: "memory_forget",
  description: "Forget one memory by key, memories by tag, or all memories.",
  schema: z.object({
    key: z.string().optional().describe("Memory key to delete."),
    tag: z.string().optional().describe("Delete all memories with this tag."),
    confirmForgetAll: z
      .boolean()
      .optional()
      .describe("Set true to delete all memories."),
  }),
});

export const geolocationGet = tool({
  name: "geolocation_get",
  description:
    "Get the user's current GPS coordinates in the browser and optionally save them to memory.",
  schema: z.object({
    save: z.boolean().optional().describe("Save coordinates to memory."),
  }),
});

export const headlessTools = [
  memoryPut,
  memoryGet,
  memoryList,
  memorySearch,
  memoryForget,
  geolocationGet,
];
