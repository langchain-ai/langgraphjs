import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { v6 } from "@langchain/core/utils/uuid";

const NOW = Date.UTC(2026, 9, 16);

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("checkpoint UUID ordering", () => {
  it("continues after a parent minted in another process with a later clock", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const parent = v6({ msecs: NOW + 60_000, nsecs: 135, clockseq: 10 });
    const { uuid6 } = await import("../id.js");
    const child = uuid6(0, parent);
    expect(child > parent).toBe(true);
    expect(uuid6(-1, child) > child).toBe(true);
  });

  it("orders after a parent at the final tick of a millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const parent = v6({ msecs: NOW + 60_000, nsecs: 9999, clockseq: 10 });
    const { uuid6 } = await import("../id.js");
    expect(uuid6(0, parent) > parent).toBe(true);
  });

  it("keeps process-local IDs increasing when the clock rolls back", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { uuid6 } = await import("../id.js");
    const first = uuid6(10);
    clock.mockReturnValue(NOW - 60_000);
    const second = uuid6(0);
    expect(second > first).toBe(true);
    expect(uuid6(-1) > second).toBe(true);
  });

  it("keeps increasing after more than 10,000 IDs in one millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { uuid6 } = await import("../id.js");
    let previous = uuid6(10);
    for (let index = 0; index < 10_002; index += 1) {
      const next = uuid6(index % 2);
      expect(next > previous).toBe(true);
      previous = next;
    }
  });

  it("accepts legacy non-v6 IDs without interpreting their timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { uuid6 } = await import("../id.js");
    expect(() => uuid6(0, "custom-checkpoint-id")).not.toThrow();
    expect(() => uuid6(0, "00000000-0000-4000-8000-000000000000")).not.toThrow();
  });
});
