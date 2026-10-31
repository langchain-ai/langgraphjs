import { describe, it, expect, afterEach, vi } from "vitest";
import { uuid6 } from "../id.js";

/**
 * Checkpoint IDs are compared lexicographically — every saver resolves "the
 * latest checkpoint" with a descending sort on `checkpoint_id`. So successive
 * `uuid6()` calls have to keep producing increasing ids even when the wall
 * clock does not cooperate.
 */
describe("uuid6", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("increases while the clock stands still", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const ids = [uuid6(1), uuid6(1), uuid6(1)];

    expect([...ids].sort()).toEqual(ids);
  });

  it("increases when the clock steps backwards", () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_001_000)
      .mockReturnValueOnce(1_700_000_000_500);

    const first = uuid6(1);
    const second = uuid6(1);

    expect(now).toHaveBeenCalledTimes(2);
    expect(second > first).toBe(true);
  });

  it("keeps increasing after the clock catches back up", () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_700_000_002_000)
      .mockReturnValueOnce(1_700_000_001_000)
      .mockReturnValueOnce(1_700_000_002_001);

    const ids = [uuid6(1), uuid6(1), uuid6(1)];

    expect([...ids].sort()).toEqual(ids);
  });
});
