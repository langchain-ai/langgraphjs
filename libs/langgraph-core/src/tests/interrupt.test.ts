import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import {
  Annotation,
  Command,
  START,
  StateGraph,
  interrupt,
  type InterruptOptions,
} from "../index.js";

const State = Annotation.Root({
  answer: Annotation<unknown>(),
});

const RAW_SCHEMA = {
  type: "object",
  properties: { approved: { type: "boolean" } },
};
const ZOD_SCHEMA = z.object({
  approved: z.boolean(),
  note: z.string().default(""),
});

const buildGraph = (responseSchema: InterruptOptions["responseSchema"]) =>
  new StateGraph(State)
    .addNode("node", () => ({
      answer: interrupt({ question: "approve?" }, { responseSchema }),
    }))
    .addEdge(START, "node")
    .compile({ checkpointer: new MemorySaver() });

describe("interrupt responseSchema", () => {
  it.each([
    ["none", undefined, undefined, { approved: true, extra: 1 }],
    ["raw JSON Schema", RAW_SCHEMA, RAW_SCHEMA, { approved: true, extra: 1 }],
    ["zod", ZOD_SCHEMA, toJsonSchema(ZOD_SCHEMA), { approved: true, note: "" }],
  ] as const)(
    "surfaces %s on the interrupt and resumes",
    async (_label, responseSchema, expectedSchema, expectedAnswer) => {
      const graph = buildGraph(responseSchema);
      const config = { configurable: { thread_id: "1" } };
      const expected = {
        id: expect.any(String),
        value: { question: "approve?" },
        ...(expectedSchema === undefined
          ? {}
          : { response_schema: expectedSchema }),
      };

      const result = await graph.invoke({ answer: null }, config);
      expect(result).toMatchObject({ __interrupt__: [expected] });
      expect((await graph.getState(config)).tasks[0].interrupts).toEqual([
        expected,
      ]);

      await expect(
        graph.invoke(new Command({ resume: { approved: true, extra: 1 } }), config)
      ).resolves.toEqual({ answer: expectedAnswer });
    }
  );

  it("rejects a resume value that does not match a zod responseSchema", async () => {
    const graph = buildGraph(ZOD_SCHEMA);
    const config = { configurable: { thread_id: "1" } };
    await graph.invoke({ answer: null }, config);

    await expect(
      graph.invoke(new Command({ resume: { approved: "nope" } }), config)
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["approved"] })],
    });

    await expect(
      graph.invoke(new Command({ resume: { approved: false } }), config)
    ).resolves.toEqual({ answer: { approved: false, note: "" } });
  });
});
