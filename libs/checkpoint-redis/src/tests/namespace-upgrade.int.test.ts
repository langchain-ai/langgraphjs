import { it, expect } from "vitest";
import { SchemaFieldTypes } from "redis";
import { RedisStore } from "../store.js";
import { createRedisContainer } from "./redis-container.js";

it("prepares an existing TEXT index while keeping old readers and writers compatible", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    await client.ft.create(
      "store",
      {
        "$.prefix": { type: SchemaFieldTypes.TEXT, AS: "prefix" },
        "$.key": { type: SchemaFieldTypes.TAG, AS: "key" },
        "$.created_at": { type: SchemaFieldTypes.NUMERIC, AS: "created_at" },
        "$.updated_at": { type: SchemaFieldTypes.NUMERIC, AS: "updated_at" },
      },
      { ON: "JSON", PREFIX: "store:" }
    );
    for (const [id, prefix] of [
      ["own", "tenant.a"],
      ["sibling", "tenant.ab"],
    ]) {
      await client.json.set(`store:${id}`, "$", {
        prefix,
        key: id,
        value: { text: id },
        created_at: 1,
        updated_at: 1,
      });
    }
    const oldQuery = "@prefix:(tenant*)";
    const before = await client.ft.search("store", oldQuery);
    expect(before.total).toBe(2);
    const store = new RedisStore(client);
    await expect(store.search(["tenant", "a"])).rejects.toThrow(
      "Run await store.setup()"
    );
    await expect(store.get(["tenant", "a"], "own")).rejects.toThrow(
      "Run await store.setup()"
    );
    await expect(
      store.put(["tenant", "a"], "own", { text: "changed" })
    ).rejects.toThrow("Run await store.setup()");
    await expect(store.delete(["tenant", "a"], "own")).rejects.toThrow(
      "Run await store.setup()"
    );
    expect(await client.json.get("store:own")).toMatchObject({
      value: { text: "own" },
    });
    expect((await client.ft.search("store", oldQuery)).total).toBe(2);
    await store.setup();
    await store.setup();
    const after = await client.ft.search("store", oldQuery);
    expect(after.total).toBe(before.total);
    expect(after.documents).toEqual(expect.arrayContaining(before.documents));
    expect(
      (await store.search(["tenant", "a"])).map((item) => item.key)
    ).toEqual(["own"]);
    // Existing writers continue using the original document format.
    await client.json.set("store:later", "$", {
      prefix: "tenant.a",
      key: "later",
      value: { text: "later" },
      created_at: 2,
      updated_at: 2,
    });
    const reader = new RedisStore(client);
    expect(
      (await reader.search(["tenant", "a"])).map((item) => item.key)
    ).toEqual(["later", "own"]);
    expect((await client.ft.search("store", oldQuery)).total).toBe(3);
  } finally {
    await cleanup();
  }
});

it("rejects incompatible namespace fields without rewriting existing data", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    for (const field of [
      { type: SchemaFieldTypes.TEXT, AS: "namespace" },
      { type: SchemaFieldTypes.TAG, AS: "namespace" },
      {
        type: SchemaFieldTypes.TAG,
        AS: "namespace",
        CASESENSITIVE: true,
        SEPARATOR: ",",
      },
    ] as const) {
      await client.flushDb();
      await client.ft.create(
        "store",
        { "$.prefix": field },
        { ON: "JSON", PREFIX: "store:" }
      );
      const value = {
        prefix: "tenant.a",
        key: "k",
        value: { text: "original" },
      };
      await client.json.set("store:k", "$", value);
      const store = new RedisStore(client);
      await expect(store.setup()).rejects.toThrow("Run await store.setup()");
      await expect(store.search(["tenant", "a"])).rejects.toThrow(
        "Run await store.setup()"
      );
      expect(await client.json.get("store:k")).toEqual(value);
    }
  } finally {
    await cleanup();
  }
});

it("reports denied index permissions and allows recovery after permissions are restored", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    const store = new RedisStore(client);
    await store.setup();
    await store.put(["tenant", "a"], "k", { text: "original" });
    for (const command of ["ft.info", "ft.alter", "ft.tagvals", "ft.search"]) {
      await client.sendCommand([
        "ACL",
        "SETUSER",
        "namespace-test",
        "reset",
        "on",
        "nopass",
        "~*",
        "+@all",
        `-${command}`,
      ]);
      const restricted = client.duplicate({ username: "namespace-test" });
      await restricted.connect();
      try {
        const reader = new RedisStore(restricted);
        if (command === "ft.alter") {
          await expect(reader.setup()).rejects.toThrow("NOPERM");
        } else if (command === "ft.info") {
          await expect(reader.search(["tenant", "a"])).rejects.toThrow(
            "Run await store.setup()"
          );
        } else {
          await expect(reader.search(["tenant", "a"])).rejects.toThrow(
            "NOPERM"
          );
        }
        if (command === "ft.search") {
          await expect(
            reader.put(["tenant", "a"], "k", { text: "changed" })
          ).rejects.toThrow("NOPERM");
          await expect(reader.delete(["tenant", "a"], "k")).rejects.toThrow(
            "NOPERM"
          );
        }
        expect((await store.get(["tenant", "a"], "k"))?.value).toEqual({
          text: "original",
        });
        await client.sendCommand(["ACL", "SETUSER", "namespace-test", "+@all"]);
        await reader.setup();
        expect(
          (await reader.search(["tenant", "a"])).map((item) => item.key)
        ).toEqual(["k"]);
      } finally {
        await restricted.disconnect();
      }
    }
  } finally {
    await cleanup();
  }
});

it("keeps long-lived readers isolated after index replacement", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    const store = new RedisStore(client);
    await store.setup();
    await store.put(["tenant", "a"], "own", {});
    await store.put(["tenant", "A"], "sibling", {});
    expect(
      (await store.search(["tenant", "a"])).map((item) => item.key)
    ).toEqual(["own"]);
    await client.ft.dropIndex("store");
    await client.ft.create(
      "store",
      {
        "$.prefix": { type: SchemaFieldTypes.TAG, AS: "namespace" },
        "$.key": { type: SchemaFieldTypes.TAG, AS: "key" },
        "$.created_at": { type: SchemaFieldTypes.NUMERIC, AS: "created_at" },
      },
      { ON: "JSON", PREFIX: "store:" }
    );
    await expect
      .poll(
        async () =>
          (
            await client.ft.search("store", "*", {
              LIMIT: { from: 0, size: 0 },
            })
          ).total
      )
      .toBe(2);
    await expect(store.search(["tenant", "a"])).rejects.toThrow(
      "Run await store.setup()"
    );
  } finally {
    await cleanup();
  }
});

it("preserves whitespace and punctuation in namespace identity", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    const store = new RedisStore(client);
    await store.setup();
    const labels = ["a", "a ", " a", "\t", "a\\b", "a|b", "{a}", "a,b", "a\nb"];
    for (let i = 0; i < labels.length; i++)
      await store.put(["tenant", labels[i]], String(i), {});
    for (let i = 0; i < labels.length; i++) {
      expect(
        (await store.search(["tenant", labels[i]])).map((item) => item.key)
      ).toEqual([String(i)]);
      expect((await store.get(["tenant", labels[i]], String(i)))?.key).toBe(
        String(i)
      );
    }
  } finally {
    await cleanup();
  }
});

it("supports concurrent setup and factory-created clients, and detects dropped indexes", async () => {
  const { client, url, cleanup } = await createRedisContainer();
  try {
    const first = new RedisStore(client);
    const second = new RedisStore(client);
    await Promise.all([first.setup(), second.setup()]);
    await first.put(["tenant", "a"], "k", {});
    const factory = await RedisStore.fromConnString(url);
    try {
      expect((await factory.get(["tenant", "a"], "k"))?.key).toBe("k");
    } finally {
      await factory.close();
    }
    await client.ft.dropIndex("store");
    await expect(first.get(["tenant", "a"], "k")).rejects.toThrow(
      "Run await store.setup()"
    );
    await expect(first.search(["tenant", "a"])).rejects.toThrow(
      "Run await store.setup()"
    );
    await expect(first.delete(["tenant", "a"], "k")).rejects.toThrow(
      "Run await store.setup()"
    );
    await first.setup();
    expect((await first.get(["tenant", "a"], "k"))?.key).toBe("k");
  } finally {
    await cleanup();
  }
});

it("recovers from partial preparation when the vector index is incompatible", async () => {
  const { client, cleanup } = await createRedisContainer();
  try {
    await client.ft.create(
      "store_vectors",
      { "$.prefix": { type: SchemaFieldTypes.TEXT, AS: "namespace" } },
      { ON: "JSON", PREFIX: "store_vectors:" }
    );
    const store = new RedisStore(client, {
      index: {
        dims: 2,
        embed: {
          embedDocuments: async (texts: string[]) => texts.map(() => [1, 0]),
        },
      },
    });
    await expect(store.setup()).rejects.toThrow("Run await store.setup()");
    await expect(store.search(["tenant"], { query: "hello" })).rejects.toThrow(
      "Run await store.setup()"
    );
    expect(await store.search(["tenant"])).toEqual([]);
    await client.ft.dropIndex("store_vectors");
    await store.setup();
    await store.put(["tenant"], "k", { text: "hello" });
    expect(
      (await store.search(["tenant"], { query: "hello" })).map(
        (item) => item.key
      )
    ).toEqual(["k"]);
  } finally {
    await cleanup();
  }
});
