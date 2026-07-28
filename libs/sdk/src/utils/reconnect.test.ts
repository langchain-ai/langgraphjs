import { describe, expect, it } from "vitest";

import { reconnectDelayMs } from "./reconnect.js";

describe("reconnectDelayMs", () => {
  it("caps exponential backoff", () => {
    expect(reconnectDelayMs(1)).toBeLessThanOrEqual(6000);
    expect(reconnectDelayMs(10)).toBeLessThanOrEqual(6000);
  });
});
