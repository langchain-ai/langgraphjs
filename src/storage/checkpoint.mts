import { MemorySaver } from "@langchain/langgraph";

class InMemorySaver extends MemorySaver {
  clear() {
    this.storage = {};
    this.writes = {};
  }
}

export const checkpointer = new InMemorySaver();
