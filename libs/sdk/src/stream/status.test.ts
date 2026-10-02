import { describe, expect, it } from "vitest";

import { deriveStreamStatus } from "./status.js";

describe("deriveStreamStatus", () => {
  it("is idle when not loading and no error", () => {
    expect(
      deriveStreamStatus({ isLoading: false, isRunning: false, error: undefined })
    ).toBe("idle");
  });

  it("is submitting while loading but not yet running", () => {
    expect(
      deriveStreamStatus({ isLoading: true, isRunning: false, error: undefined })
    ).toBe("submitting");
  });

  it("is streaming once the run is running", () => {
    expect(
      deriveStreamStatus({ isLoading: true, isRunning: true, error: undefined })
    ).toBe("streaming");
  });

  it("is error whenever an error is present, regardless of loading", () => {
    expect(
      deriveStreamStatus({ isLoading: false, isRunning: false, error: new Error("x") })
    ).toBe("error");
    expect(
      deriveStreamStatus({ isLoading: true, isRunning: true, error: "boom" })
    ).toBe("error");
  });
});
