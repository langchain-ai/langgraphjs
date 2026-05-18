import { expect } from "vitest";
import { INTERRUPT, isInterrupted } from "../../constants.js";

export const interruptMatchers = {
  toBeInterrupted(received: unknown) {
    const pass = isInterrupted(received);
    return {
      pass,
      message: () =>
        pass
          ? "expected value not to be interrupted"
          : "expected value to be interrupted",
    };
  },

  toHaveInterruptValue(received: unknown, expected: unknown) {
    if (!isInterrupted(received)) {
      return {
        pass: false,
        message: () =>
          `expected interrupted result with value ${String(
            expected
          )}, but value is not interrupted`,
      };
    }

    const actual = received[INTERRUPT][0]?.value;
    const pass = actual === expected;

    return {
      pass,
      message: () =>
        pass
          ? `expected interrupt value not to be ${String(expected)}`
          : `expected interrupt value ${String(expected)}, received ${String(
              actual
            )}`,
    };
  },
};

expect.extend(interruptMatchers);

interface InterruptMatchers {
  toBeInterrupted(): unknown;
  toHaveInterruptValue(expected: unknown): unknown;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends InterruptMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends InterruptMatchers {}
}
