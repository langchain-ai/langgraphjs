import { describe, expect, it } from "vitest";
import { onFinishRequiresThreadState } from "./utils.js";

describe("onFinishRequiresThreadState", () => {
  it("is false for undefined", () => {
    expect(onFinishRequiresThreadState(undefined)).toBe(false);
  });

  it("is false for zero-arity callbacks", () => {
    expect(onFinishRequiresThreadState(() => {})).toBe(false);
  });

  it("is true when the callback declares parameters", () => {
    expect(onFinishRequiresThreadState((_s: unknown) => {})).toBe(true);
    expect(onFinishRequiresThreadState((_s: unknown, _r: unknown) => {})).toBe(
      true
    );
  });
});
