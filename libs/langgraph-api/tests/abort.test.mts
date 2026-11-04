import { expect, it, vi } from "vitest";

class ExpectedCancellation extends Error {}

vi.mock("@langchain/core/errors", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ExpectedCancellation,
}));

it("extends core's ExpectedCancellation when core exports it", async () => {
  const { RunCancellation } = await import("../src/utils/abort.mjs");
  const reason = new RunCancellation("rollback");

  expect(reason).toBeInstanceOf(ExpectedCancellation);
  expect(reason.name).toBe("RunCancellation");
  expect(reason.action).toBe("rollback");
});
