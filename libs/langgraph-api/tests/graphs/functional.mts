import { entrypoint } from "@langchain/langgraph";

// A functional graph: its state values are the entrypoint's return value.
export const graph = entrypoint(
  "functional",
  async (input: string) => `echo ${input}`
);
