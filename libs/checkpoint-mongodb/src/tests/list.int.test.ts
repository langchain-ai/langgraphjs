import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient } from "mongodb";
import { emptyCheckpoint, uuid6 } from "@langchain/langgraph-checkpoint";
import { getEnvironmentVariable } from "@langchain/core/utils/env";
import { MongoDBSaver } from "../index.js";

const client = new MongoClient(getEnvironmentVariable("MONGODB_URL")!, {
  auth: { username: "user", password: "password" },
});
const dbName = `list_bounds_${uuid6(0)}`;
const saver = new MongoDBSaver({ client, dbName });
const config = { configurable: { thread_id: "target", checkpoint_ns: "" } };

beforeAll(async () => {
  await saver.setup();
  for (const [thread_id, checkpoint_ns] of [
    ["target", ""],
    ["target", "child"],
    ["other", ""],
  ]) {
    for (const id of ["0001", "0002"]) {
      const stored = await saver.put(
        { configurable: { thread_id, checkpoint_ns } },
        { ...emptyCheckpoint(), id },
        { source: "loop", step: Number(id), parents: {} }
      );
      await saver.putWrites(stored, [["value", id]], "writer");
    }
  }
});

afterAll(async () => {
  await client.db(dbName).dropDatabase();
  await client.close();
});

describe("MongoDBSaver.list query bounds", () => {
  it.each([
    { limit: undefined, expected: ["0002", "0001"] },
    { limit: 0, expected: [] },
    { limit: 1, expected: ["0002"] },
    { limit: 2, expected: ["0002", "0001"] },
  ])("returns $expected for limit=$limit", async ({ limit, expected }) => {
    const tuples = [];
    for await (const tuple of saver.list(config, { limit })) tuples.push(tuple);
    expect(tuples.map((tuple) => tuple.checkpoint.id)).toEqual(expected);
  });

  it.each([
    { id: "0001", before: undefined, expected: ["0001"] },
    { id: "missing", before: undefined, expected: [] },
    { id: "0001", before: "0002", expected: ["0001"] },
    { id: "0002", before: "0002", expected: [] },
    { id: "0002", before: "0001", expected: [] },
  ])(
    "selects checkpoint=$id before=$before",
    async ({ id, before, expected }) => {
      const tuples = [];
      for await (const tuple of saver.list(
        { configurable: { ...config.configurable, checkpoint_id: id } },
        {
          before: before === undefined
            ? undefined
            : { configurable: { checkpoint_id: before } },
        }
      )) tuples.push(tuple);

      expect(tuples.map((tuple) => tuple.checkpoint.id)).toEqual(expected);
      for (const tuple of tuples) {
        expect(tuple.config.configurable).toMatchObject(config.configurable);
        expect(tuple.pendingWrites).toEqual([["writer", "value", id]]);
      }
    }
  );

  it("combines a selected checkpoint with metadata filters", async () => {
    const tuples = [];
    for await (const tuple of saver.list(
      { configurable: { ...config.configurable, checkpoint_id: "0001" } },
      { filter: { step: 2 } }
    )) tuples.push(tuple);
    expect(tuples).toEqual([]);
  });
});
