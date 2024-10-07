import { MemorySaver } from "@langchain/langgraph-checkpoint";

export const initializer = {
  saverName: "MemorySaver",
  createSaver: () => new MemorySaver(),
};

export default initializer;
