import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  type JSONSchema,
  toJsonSchema,
} from "@langchain/core/utils/json_schema";
import {
  Annotation,
  Command,
  START,
  StateGraph,
  interrupt,
  isInvalidResume,
  type InterruptOptions,
} from "../index.js";

const State = Annotation.Root({
  answer: Annotation<unknown>(),
});

const RAW_SCHEMA: JSONSchema = {
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

  it.each(["null", "map"] as const)(
    "corrects an invalid %s resume for a later interrupt in the same node",
    async (resumeStyle) => {
      const graph = new StateGraph(State)
        .addNode("node", () => {
          const first = interrupt("first");
          const second = interrupt("approve?", { responseSchema: ZOD_SCHEMA });
          return { answer: [first, second] };
        })
        .addEdge(START, "node")
        .compile({ checkpointer: new MemorySaver() });
      const config = { configurable: { thread_id: "1" } };
      await graph.invoke({ answer: null }, config);
      await graph.invoke(new Command({ resume: "ok" }), config);
      const [pending] = (await graph.getState(config)).tasks[0].interrupts;
      const resumeWith = (value: unknown) =>
        resumeStyle === "null" ? value : { [pending.id ?? ""]: value };

      await expect(
        graph.invoke(
          new Command({ resume: resumeWith({ approved: "nope" }) }),
          config
        )
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ["approved"] })],
      });

      await expect(
        graph.invoke(
          new Command({ resume: resumeWith({ approved: true }) }),
          config
        )
      ).resolves.toEqual({ answer: ["ok", { approved: true, note: "" }] });
    }
  );

  it.each(["null", "map"] as const)(
    "rejects a %s resume that does not match a zod responseSchema, then accepts a corrected one",
    async (resumeStyle) => {
      const graph = buildGraph(ZOD_SCHEMA);
      const config = { configurable: { thread_id: "1" } };
      await graph.invoke({ answer: null }, config);
      const [pending] = (await graph.getState(config)).tasks[0].interrupts;
      const resumeWith = (value: unknown) =>
        resumeStyle === "null" ? value : { [pending.id ?? ""]: value };

      await expect(
        graph.invoke(
          new Command({ resume: resumeWith({ approved: "nope" }) }),
          config
        )
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ["approved"] })],
      });

      await expect(
        graph.invoke(
          new Command({ resume: resumeWith({ approved: false }) }),
          config
        )
      ).resolves.toEqual({ answer: { approved: false, note: "" } });
    }
  );

  it("marks only resume validation errors as invalid resumes", async () => {
    const graph = buildGraph(ZOD_SCHEMA);
    const config = { configurable: { thread_id: "1" } };
    await graph.invoke({ answer: null }, config);
    const error: unknown = await graph
      .invoke(new Command({ resume: { approved: "nope" } }), config)
      .catch((e: unknown) => e);

    expect([
      isInvalidResume(error),
      // Agent middleware rethrows errors wrapped, with the original as `cause`.
      isInvalidResume(new Error("wrapped", { cause: error })),
      isInvalidResume(ZOD_SCHEMA.safeParse({}).error),
      isInvalidResume(new Error("nope")),
    ]).toEqual([true, true, false, false]);
  });

  // A task cut off after its side effect keeps its answer and runs again on the
  // next resume, so the side effect would happen twice.
  it("lets the other answered tasks finish when one answer is invalid", async () => {
    const sent: string[] = [];
    const LogState = Annotation.Root({
      log: Annotation<string[]>({
        reducer: (left, right) => left.concat(right),
        default: () => [],
      }),
    });
    const graph = new StateGraph(LogState)
      .addNode("send", async () => {
        interrupt("send?", { responseSchema: ZOD_SCHEMA });
        sent.push("email");
        // Waiting on the reply to a request already sent.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { log: ["sent"] };
      })
      .addNode("check", async () => {
        interrupt("check?", { responseSchema: ZOD_SCHEMA });
        return { log: ["checked"] };
      })
      .addEdge(START, "send")
      .addEdge(START, "check")
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: "1" } };
    await graph.invoke({ log: [] }, config);
    const ids = Object.fromEntries(
      (await graph.getState(config)).tasks
        .flatMap((task) => task.interrupts)
        .map((i) => [String(i.value), i.id ?? ""])
    );

    await expect(
      graph.invoke(
        new Command({
          resume: {
            [ids["send?"]]: { approved: true },
            [ids["check?"]]: { approved: "nope" },
          },
        }),
        config
      )
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: ["approved"] })],
    });
    const failed = (await graph.getState(config)).tasks
      .filter((task) => task.error !== undefined)
      .map((task) => task.name);
    expect([failed, sent]).toEqual([["check"], ["email"]]);

    const result = await graph.invoke(
      new Command({ resume: { [ids["check?"]]: { approved: true } } }),
      config
    );
    expect([[...result.log].sort(), sent]).toEqual([
      ["checked", "sent"],
      ["email"],
    ]);
  });
});
