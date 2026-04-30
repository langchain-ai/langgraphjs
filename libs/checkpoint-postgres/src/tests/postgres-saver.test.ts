import { describe, it, expect } from "vitest";
import { PostgresSaver } from "../index.js";

/**
 * Helper to create a PostgresSaver with a mocked pg.Pool.
 * Unit tests don't need a real database connection.
 */
function createSaver() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockPool = {} as any;
  return new PostgresSaver(mockPool);
}

/**
 * Access protected methods for testing via a thin subclass.
 */
class TestableSaver extends PostgresSaver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    super({} as any);
  }

  public testDumpCheckpoint(
    ...args: Parameters<PostgresSaver["_dumpCheckpoint"]>
  ) {
    return this._dumpCheckpoint(...args);
  }

  public testDumpBlobs(...args: Parameters<PostgresSaver["_dumpBlobs"]>) {
    return this._dumpBlobs(...args);
  }

  public testLoadCheckpoint(
    ...args: Parameters<PostgresSaver["_loadCheckpoint"]>
  ) {
    return this._loadCheckpoint(...args);
  }
}

// ─── getNextVersion ──────────────────────────────────────────────────────────

describe("getNextVersion", () => {
  const saver = createSaver();

  it("should produce a string with 32-char zero-padded counter and 16-char hash", () => {
    const version = saver.getNextVersion(undefined);
    expect(typeof version).toBe("string");

    const str = version as string;
    const [counter, hash] = str.split(".");
    expect(counter).toHaveLength(32);
    expect(hash).toHaveLength(16);
  });

  it("should start at counter 1 when current is undefined", () => {
    const version = saver.getNextVersion(undefined) as string;
    const counter = version.split(".")[0];
    expect(parseInt(counter, 10)).toBe(1);
    // Should be zero-padded
    expect(counter).toMatch(/^0{31}1$/);
  });

  it("should increment the counter from a string version", () => {
    const v1 = saver.getNextVersion(undefined) as string;
    const v2 = saver.getNextVersion(v1) as string;

    const c1 = parseInt(v1.split(".")[0], 10);
    const c2 = parseInt(v2.split(".")[0], 10);
    expect(c2).toBe(c1 + 1);
  });

  it("should handle legacy integer versions (backward compat)", () => {
    // Old checkpoints stored integer versions like 1, 2, 3
    const version = saver.getNextVersion(3) as string;
    const [counter, hash] = version.split(".");
    expect(parseInt(counter, 10)).toBe(4);
    expect(counter).toHaveLength(32);
    expect(hash).toHaveLength(16);
  });

  it("should produce unique versions (different random hash each call)", () => {
    const versions = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      versions.add(saver.getNextVersion(undefined) as string);
    }
    // With random hashes, all 100 should be unique
    expect(versions.size).toBe(100);
  });

  it("should produce monotonically increasing versions by counter", () => {
    let current: string | number | undefined;
    for (let i = 0; i < 10; i += 1) {
      const next = saver.getNextVersion(current) as string;
      const nextCounter = parseInt(next.split(".")[0], 10);
      expect(nextCounter).toBe(i + 1);
      current = next;
    }
  });

  it("should produce versions that sort correctly as strings", () => {
    // This is critical for Postgres ORDER BY to work correctly
    const v1 = saver.getNextVersion(undefined) as string;
    const v2 = saver.getNextVersion(v1) as string;
    const v3 = saver.getNextVersion(v2) as string;

    expect(v1 < v2).toBe(true);
    expect(v2 < v3).toBe(true);
  });

  it("should produce format compatible with Python checkpoint-postgres", () => {
    // Python format: f"{next_v:032}.{next_h:016}"
    // The JS version should match this pattern
    const version = saver.getNextVersion(undefined) as string;
    // Full format: 32 digits, dot, 16 digits
    expect(version).toMatch(/^\d{32}\.\d{16}$/);
  });
});

// ─── _dumpCheckpoint ─────────────────────────────────────────────────────────

describe("_dumpCheckpoint", () => {
  const saver = new TestableSaver();

  it("should inline primitive channel_values (string, number, boolean, null)", () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {
        strVal: "hello",
        numVal: 42,
        boolVal: true,
        nullVal: null,
      },
      channel_versions: {},
      versions_seen: {},
    };

    const result = saver.testDumpCheckpoint(checkpoint);
    expect(result.channel_values).toEqual({
      strVal: "hello",
      numVal: 42,
      boolVal: true,
      nullVal: null,
    });
  });

  it("should exclude complex values from inline channel_values", () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {
        strVal: "hello",
        arrayVal: [1, 2, 3],
        objVal: { nested: true },
      },
      channel_versions: {},
      versions_seen: {},
    };

    const result = saver.testDumpCheckpoint(checkpoint);
    // Only the primitive is inlined
    expect(result.channel_values).toEqual({
      strVal: "hello",
    });
    // Complex values should NOT be in the serialized checkpoint
    const cv = result.channel_values as Record<string, unknown>;
    expect(cv.arrayVal).toBeUndefined();
    expect(cv.objVal).toBeUndefined();
  });

  it("should handle empty channel_values", () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    };

    const result = saver.testDumpCheckpoint(checkpoint);
    expect(result.channel_values).toEqual({});
  });

  it("should preserve other checkpoint fields", () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: { key: "value" },
      channel_versions: { key: 1 },
      versions_seen: { node: { key: 1 } },
    };

    const result = saver.testDumpCheckpoint(checkpoint);
    expect(result.v).toBe(4);
    expect(result.id).toBe("test-id");
    expect(result.ts).toBe("2024-01-01T00:00:00Z");
    expect(result.channel_versions).toEqual({ key: 1 });
    expect(result.versions_seen).toEqual({ node: { key: 1 } });
  });
});

// ─── _dumpBlobs ──────────────────────────────────────────────────────────────

describe("_dumpBlobs", () => {
  const saver = new TestableSaver();

  it("should skip primitive values (stored inline in checkpoint)", async () => {
    const values = {
      strKey: "hello",
      numKey: 42,
      boolKey: true,
      nullKey: null,
    };
    const versions = {
      strKey: "00000000000000000000000000000001.1234567890123456",
      numKey: "00000000000000000000000000000001.2345678901234567",
      boolKey: "00000000000000000000000000000001.3456789012345678",
      nullKey: "00000000000000000000000000000001.4567890123456789",
    };

    const result = await saver.testDumpBlobs("thread-1", "", values, versions);

    // All values are primitives, so nothing should be dumped to blobs
    expect(result).toHaveLength(0);
  });

  it("should include complex values in blob output", async () => {
    const values = {
      arrayKey: [1, 2, 3],
      objKey: { nested: true },
    };
    const versions = {
      arrayKey: "00000000000000000000000000000001.1234567890123456",
      objKey: "00000000000000000000000000000001.2345678901234567",
    };

    const result = await saver.testDumpBlobs("thread-1", "", values, versions);

    expect(result).toHaveLength(2);
    // Each blob tuple: [threadId, checkpointNs, key, version, type, bytes]
    const keys = result.map((r) => r[2]);
    expect(keys).toContain("arrayKey");
    expect(keys).toContain("objKey");
  });

  it("should handle mix of primitive and complex values", async () => {
    const values = {
      strKey: "hello",
      arrayKey: [1, 2, 3],
      numKey: 42,
      objKey: { nested: true },
    };
    const versions = {
      strKey: "v1",
      arrayKey: "v1",
      numKey: "v1",
      objKey: "v1",
    };

    const result = await saver.testDumpBlobs("thread-1", "", values, versions);

    // Only complex values should be in blobs
    expect(result).toHaveLength(2);
    const keys = result.map((r) => r[2]);
    expect(keys).toContain("arrayKey");
    expect(keys).toContain("objKey");
    expect(keys).not.toContain("strKey");
    expect(keys).not.toContain("numKey");
  });

  it("should return empty array when versions is empty", async () => {
    const result = await saver.testDumpBlobs(
      "thread-1",
      "",
      { key: "val" },
      {}
    );
    expect(result).toEqual([]);
  });

  it("should handle channels with version but missing from values (empty type)", async () => {
    const values = {};
    const versions = { missingKey: "v1" };

    const result = await saver.testDumpBlobs("thread-1", "", values, versions);

    expect(result).toHaveLength(1);
    expect(result[0][2]).toBe("missingKey");
    expect(result[0][4]).toBe("empty");
    expect(result[0][5]).toBeUndefined();
  });
});

// ─── _loadCheckpoint ─────────────────────────────────────────────────────────

describe("_loadCheckpoint", () => {
  const saver = new TestableSaver();

  it("should merge inline primitives from checkpoint with blob values", async () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {
        inlineKey: "inlineValue",
      },
      channel_versions: {},
      versions_seen: {},
    };

    const encoder = new TextEncoder();
    // Simulate a blob for a complex value — use JSON serde format
    const channelValues: [Uint8Array, Uint8Array, Uint8Array][] = [
      [
        encoder.encode("blobKey"),
        encoder.encode("json"),
        encoder.encode(JSON.stringify({ complex: true })),
      ],
    ];

    const result = await saver.testLoadCheckpoint(checkpoint, channelValues);

    // Both inline and blob values should be present
    expect(result.channel_values.inlineKey).toBe("inlineValue");
    expect(result.channel_values.blobKey).toEqual({ complex: true });
  });

  it("should let blob values override inline primitives on collision", async () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {
        key: "inlineValue",
      },
      channel_versions: {},
      versions_seen: {},
    };

    const encoder = new TextEncoder();
    const channelValues: [Uint8Array, Uint8Array, Uint8Array][] = [
      [
        encoder.encode("key"),
        encoder.encode("json"),
        encoder.encode(JSON.stringify("blobValue")),
      ],
    ];

    const result = await saver.testLoadCheckpoint(checkpoint, channelValues);
    // Blob should win
    expect(result.channel_values.key).toBe("blobValue");
  });

  it("should work with empty blob values", async () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      channel_values: {
        key: "value",
      },
      channel_versions: {},
      versions_seen: {},
    };

    const result = await saver.testLoadCheckpoint(checkpoint, []);
    expect(result.channel_values.key).toBe("value");
  });

  it("should work with no inline channel_values", async () => {
    const checkpoint = {
      v: 4,
      id: "test-id",
      ts: "2024-01-01T00:00:00Z",
      // No channel_values field (pre-inline-primitive checkpoints)
      channel_versions: {},
      versions_seen: {},
    };

    const encoder = new TextEncoder();
    const channelValues: [Uint8Array, Uint8Array, Uint8Array][] = [
      [
        encoder.encode("blobKey"),
        encoder.encode("json"),
        encoder.encode(JSON.stringify([1, 2, 3])),
      ],
    ];

    const result = await saver.testLoadCheckpoint(
      checkpoint as Parameters<TestableSaver["testLoadCheckpoint"]>[0],
      channelValues
    );

    expect(result.channel_values.blobKey).toEqual([1, 2, 3]);
  });
});
