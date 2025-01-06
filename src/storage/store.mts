import { InMemoryStore as BaseMemoryStore } from "@langchain/langgraph";

class InMemoryStore extends BaseMemoryStore {
  clear() {
    // @ts-expect-error
    (this.data as unknown as Map<string, any>).clear();

    // @ts-expect-error
    (this.vectors as unknown as Map<string, any>).clear();
  }
}
export const store = new InMemoryStore();
