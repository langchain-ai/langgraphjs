import { describe, it, expect, vi } from "vitest";
import { createClient } from "redis";
import { RedisStore } from "../store.js";

function createStubClient() {
  const client = createClient();
  vi.spyOn(client.ft, "search").mockResolvedValue({ total: 0, documents: [] });

  vi.spyOn(client.ft, "tagVals").mockResolvedValue([]);
  vi.spyOn(client, "sendCommand").mockResolvedValue([
    "attributes",
    [namespaceField],
    "indexing",
    0,
  ]);
  return client;
}

const mockEmbeddings = {
  embedDocuments: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
};

function createVectorStore(client: ReturnType<typeof createStubClient>) {
  return new RedisStore(client, {
    index: { dims: 3, embed: mockEmbeddings },
  });
}

describe("RedisStore search namespace scoping", () => {
  it.each([false, true])(
    "uses exact namespace alternatives before pagination with vector=%s",
    async (vector) => {
      const client = createStubClient();
      vi.mocked(client.ft.tagVals).mockResolvedValue([
        "tenant.acme",
        "tenant.acme.notes",
        "tenant.acme2",
        "tenant.ACME",
      ]);
      const store = vector ? createVectorStore(client) : new RedisStore(client);
      await store.search(["tenant", "acme"], {
        limit: 1,
        offset: 1,
        query: vector ? "notes" : undefined,
      });
      expect(client.ft.search).toHaveBeenCalledTimes(1);
      const [, query, options] = vi.mocked(client.ft.search).mock.calls[0];
      expect(query).toContain(
        "@namespace:{tenant\\.acme|tenant\\.acme\\.notes}"
      );
      expect(query).not.toContain("acme2");
      expect(query).not.toContain("ACME");
      expect(options).toMatchObject({ LIMIT: { from: 1, size: 1 } });
      if (vector) expect(query).toContain("KNN 2");
    }
  );
  it("returns no matches without issuing an unscoped query", async () => {
    const client = createStubClient();
    expect(await new RedisStore(client).search(["missing"])).toEqual([]);
    expect(client.ft.search).not.toHaveBeenCalled();
  });
  it("searches every namespace for an empty prefix", async () => {
    const client = createStubClient();
    await new RedisStore(client).search([]);
    expect(vi.mocked(client.ft.search).mock.calls[0][1]).toBe("*");
    expect(client.ft.tagVals).not.toHaveBeenCalled();
  });
});

it.each(["tenant.a", ".", "a.", ".a", ""])(
  "rejects invalid search label %j before querying Redis",
  async (label) => {
    const client = createStubClient();
    const store = createVectorStore(client);

    for (const query of [undefined, "notes"]) {
      await expect(store.search([label], { query })).rejects.toThrow();
      await expect(
        store.batch([{ namespacePrefix: [label], query }])
      ).rejects.toThrow();
    }

    expect(client.ft.search).not.toHaveBeenCalled();
  }
);

const namespaceField = [
  "identifier",
  "$.prefix",
  "attribute",
  "namespace",
  "type",
  "TAG",
  "SEPARATOR",
  "",
  "CASESENSITIVE",
];

function createSetupClient() {
  const client = createStubClient();
  vi.spyOn(client.ft, "create").mockRejectedValue(
    new Error("Index already exists")
  );
  vi.spyOn(client.ft, "alter").mockRejectedValue(new Error("Duplicate field"));
  vi.spyOn(client, "sendCommand").mockResolvedValue([
    "attributes",
    [namespaceField],
    "indexing",
    0,
  ]);
  return client;
}

it("waits for existing records to be indexed without rewriting documents", async () => {
  const client = createSetupClient();
  vi.mocked(client.sendCommand)
    .mockResolvedValueOnce(["indexing", 1, "attributes", [namespaceField]])
    .mockResolvedValueOnce(["attributes", [namespaceField], "indexing", 0]);
  const write = vi.spyOn(client.json, "set");
  const evalCommand = vi.spyOn(client, "eval");
  await new RedisStore(client).setup();
  expect(client.sendCommand).toHaveBeenCalledTimes(2);
  expect(write).not.toHaveBeenCalled();
  expect(evalCommand).not.toHaveBeenCalled();
});

it.each([
  namespaceField.filter((value) => value !== "CASESENSITIVE"),
  namespaceField.map((value) => (value === "TAG" ? "TEXT" : value)),
  namespaceField.map((value) => (value === "$.prefix" ? "$.other" : value)),
  namespaceField.map((value) => (value === "" ? "," : value)),
])("rejects an incompatible existing namespace field: %j", async (field) => {
  const client = createSetupClient();
  vi.mocked(client.sendCommand).mockResolvedValue([
    "attributes",
    [field],
    "indexing",
    0,
  ]);
  await expect(new RedisStore(client).setup()).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining(
        "requires a case-sensitive namespace TAG"
      ),
    }),
  });
});

it("propagates index creation failures instead of trying to alter a missing index", async () => {
  const client = createSetupClient();
  vi.mocked(client.ft.create).mockRejectedValue(new Error("NOPERM"));
  await expect(new RedisStore(client).setup()).rejects.toThrow("NOPERM");
  expect(client.ft.alter).not.toHaveBeenCalled();
});

it("propagates schema update failures", async () => {
  const client = createSetupClient();
  vi.mocked(client.ft.alter).mockRejectedValue(new Error("NOPERM"));
  await expect(new RedisStore(client).setup()).rejects.toThrow("NOPERM");
});

it("fails when index readiness cannot be determined", async () => {
  const client = createSetupClient();
  vi.mocked(client.sendCommand).mockResolvedValue([
    "attributes",
    [namespaceField],
  ]);
  await expect(new RedisStore(client).setup()).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringContaining("Missing indexing status"),
    }),
  });
});

it("times out rather than serving an incompletely indexed store", async () => {
  const client = createSetupClient();
  vi.mocked(client.sendCommand).mockResolvedValue([
    "attributes",
    [namespaceField],
    "indexing",
    1,
  ]);
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(60_000);
  try {
    await expect(new RedisStore(client).setup()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("retry setup"),
      }),
    });
  } finally {
    now.mockRestore();
  }
});

it("checks readiness on each operation and retries after failed validation", async () => {
  const client = createStubClient();
  vi.mocked(client.sendCommand).mockResolvedValueOnce([
    "attributes",
    [],
    "indexing",
    0,
  ]);
  const store = new RedisStore(client);
  await expect(store.search(["tenant"])).rejects.toThrow(
    "Run await store.setup()"
  );
  expect(client.ft.search).not.toHaveBeenCalled();
  expect(client.ft.tagVals).not.toHaveBeenCalled();
  await store.search(["tenant"]);
  await store.search(["tenant"]);
  expect(client.sendCommand).toHaveBeenCalledTimes(3);
});

it.each(["get", "put", "delete"])(
  "rejects %s before querying an unprepared index",
  async (operation) => {
    const client = createStubClient();
    vi.mocked(client.sendCommand).mockResolvedValue([
      "attributes",
      [],
      "indexing",
      0,
    ]);
    const store = new RedisStore(client);
    const result =
      operation === "get"
        ? store.get(["tenant"], "k")
        : operation === "put"
          ? store.put(["tenant"], "k", {})
          : store.delete(["tenant"], "k");
    await expect(result).rejects.toThrow("Run await store.setup()");
    expect(client.ft.search).not.toHaveBeenCalled();
  }
);
