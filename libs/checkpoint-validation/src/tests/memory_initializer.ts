import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { CheckpointerTestInitializer } from "../types.js";

export const initializer: CheckpointerTestInitializer<MemorySaver> = {
  checkpointerName: "MemorySaver",
  createCheckpointer: () => new MemorySaver(),
};

export default initializer;
