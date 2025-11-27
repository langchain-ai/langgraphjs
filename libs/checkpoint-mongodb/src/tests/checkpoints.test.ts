import { describe, it, expect, vi } from "vitest";
import { type MongoClient } from "mongodb";
import { MongoDBSaver } from "../index.js";

const client = {
  appendMetadata: vi.fn(),
  db: vi.fn(() => ({})),
};

describe("MongoDBSaver", () => {
  it("should set client metadata", async () => {
    // eslint-disable-next-line no-new
    new MongoDBSaver({ client: client as unknown as MongoClient });
    expect(client.appendMetadata).toHaveBeenCalledWith({ name: "langgraphjs_checkpoint_saver" });
  });
});