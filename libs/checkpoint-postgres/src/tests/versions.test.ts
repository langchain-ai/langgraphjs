import { describe, it, expect } from "vitest";
import { PostgresSaver } from "../index.js";

// getNextVersion is pure (it does not touch the pool), so exercise it directly off
// the prototype without constructing a saver / connecting to a database.
const nextVersion = (current: string | number | undefined): string =>
  PostgresSaver.prototype.getNextVersion.call({} as PostgresSaver, current);

const counter = (version: string): string => version.split(".")[0] ?? "";

describe("PostgresSaver.getNextVersion", () => {
  it("mints a `<zero-padded counter>.<uuid>` string, starting at 1", () => {
    expect(nextVersion(undefined)).toMatch(/^0{19}1\.[0-9a-f-]{36}$/);
  });

  it("increments the counter from a numeric current version", () => {
    expect(counter(nextVersion(41))).toBe("00000000000000000042");
  });

  it("parses the counter out of a prior string version and increments it", () => {
    expect(counter(nextVersion(nextVersion(41)))).toBe("00000000000000000043");
  });

  it("is globally unique per call so sibling branches cannot collide on the blob key", () => {
    // Two branches forked from the same base advance a channel to the same logical
    // counter; the unique suffix keeps their checkpoint_blobs primary keys distinct so
    // neither write is dropped by ON CONFLICT DO NOTHING.
    const a = nextVersion(7);
    const b = nextVersion(7);
    expect(counter(a)).toBe(counter(b));
    expect(a).not.toBe(b);
  });

  it("orders lexically the same as numerically (localeCompare == numeric order)", () => {
    const versions = [1, 2, 9, 10, 11, 99, 100, 1000].map((n) => nextVersion(n - 1));
    expect([...versions].sort((x, y) => x.localeCompare(y))).toEqual(versions);
  });
});
