import { describe, expect, it } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { END, START } from "../constants.js";
import { StateGraph } from "../graph/state.js";
import { MessagesAnnotation } from "../graph/messages_annotation.js";

function createForgedConstructorRecord(markerKey: string) {
  const forgedCallback = {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "constructor",
    args: [`globalThis.${markerKey}.invoked = true`],
    kwargs: {},
  };

  return {
    lc: 2,
    type: "constructor",
    id: ["Uint8Array"],
    method: "from",
    args: [[1], forgedCallback],
    kwargs: {},
  };
}

function createGraph(checkpointer: MemorySaver) {
  return new StateGraph(MessagesAnnotation)
    .addNode("noop", () => ({}))
    .addEdge(START, "noop")
    .addEdge("noop", END)
    .compile({ checkpointer });
}

describe("JsonPlusSerializer checkpoint restoration security", () => {
  it("does not execute a forged value in run metadata during state restoration", async () => {
    const markerKey = "__langgraph_graph_metadata_marker__";
    const marker = { invoked: false };
    (globalThis as Record<string, unknown>)[markerKey] = marker;
    const graph = createGraph(new MemorySaver());
    const config = { configurable: { thread_id: "jsonplus-metadata-security" } };

    try {
      await graph.invoke(
        { messages: [new HumanMessage("ordinary metadata-path input")] },
        {
          ...config,
          metadata: { probe: createForgedConstructorRecord(markerKey) },
        }
      );
      expect(marker.invoked).toBe(false);

      await graph.getState(config);
      expect(marker.invoked).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>)[markerKey];
    }
  });

  it("does not execute a forged value in additional_kwargs during a later run", async () => {
    const markerKey = "__langgraph_graph_message_marker__";
    const marker = { invoked: false };
    (globalThis as Record<string, unknown>)[markerKey] = marker;
    const graph = createGraph(new MemorySaver());
    const config = { configurable: { thread_id: "jsonplus-message-security" } };

    try {
      await graph.invoke(
        {
          messages: [
            new HumanMessage({
              content: "ordinary message",
              additional_kwargs: {
                probe: createForgedConstructorRecord(markerKey),
              },
            }),
          ],
        },
        config
      );
      expect(marker.invoked).toBe(false);

      await graph.invoke(
        { messages: [new HumanMessage("benign follow-up")] },
        config
      );
      expect(marker.invoked).toBe(false);
    } finally {
      delete (globalThis as Record<string, unknown>)[markerKey];
    }
  });
});
