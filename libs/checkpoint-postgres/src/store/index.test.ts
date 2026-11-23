import { describe, it, expect, vi } from "vitest";
import { PostgresStore } from "./index.js";
import type { TTLManager } from "./modules/ttl-manager.js";

const CONNECTION_STRING = "postgresql://unused:unused@localhost:5432/unused";

function ttlManagerOf(store: PostgresStore): TTLManager {
  return (store as unknown as { ttlManager: TTLManager }).ttlManager;
}

/** Let setup() run without opening a database connection. */
function stubMigrations(store: PostgresStore): void {
  const internals = store as unknown as {
    runStoreMigrations: () => Promise<void>;
  };
  vi.spyOn(internals, "runStoreMigrations").mockResolvedValue(undefined);
}

describe("PostgresStore TTL sweeper startup", () => {
  it("uses the documented 60-minute default when no interval is configured", async () => {
    const store = new PostgresStore({
      connectionOptions: CONNECTION_STRING,
      ttl: { defaultTtl: 60 },
    });
    stubMigrations(store);
    const startSpy = vi
      .spyOn(ttlManagerOf(store), "start")
      .mockImplementation(() => {});

    await store.start();

    expect(startSpy).toHaveBeenCalledWith(60);
  });

  it("starts the sweeper with the default when ensureTables is false", async () => {
    const store = new PostgresStore({
      connectionOptions: CONNECTION_STRING,
      ttl: { defaultTtl: 60 },
      ensureTables: false,
    });
    const startSpy = vi
      .spyOn(ttlManagerOf(store), "start")
      .mockImplementation(() => {});

    await store.start();

    expect(startSpy).toHaveBeenCalledWith(60);
  });

  it("respects an explicitly configured sweep interval", async () => {
    const store = new PostgresStore({
      connectionOptions: CONNECTION_STRING,
      ttl: { defaultTtl: 60, sweepIntervalMinutes: 15 },
      ensureTables: false,
    });
    const startSpy = vi
      .spyOn(ttlManagerOf(store), "start")
      .mockImplementation(() => {});

    await store.start();

    expect(startSpy).toHaveBeenCalledWith(15);
  });

  it("stops the TTL manager on stop()", async () => {
    const store = new PostgresStore({
      connectionOptions: CONNECTION_STRING,
      ttl: { defaultTtl: 60 },
      ensureTables: false,
    });
    const stopSpy = vi
      .spyOn(ttlManagerOf(store), "stop")
      .mockImplementation(() => {});

    await store.stop();

    expect(stopSpy).toHaveBeenCalledOnce();
  });
});
