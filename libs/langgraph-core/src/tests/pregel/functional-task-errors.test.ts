import { expect, it, vi } from "vitest";
import { MemorySaver, entrypoint, task, interrupt, Command } from "../../web.js";

it.each([false, true])("lets the caller recover from a failed task (checkpoint: %s)", async (checkpoint) => {
  const failure = new Error("card declined");
  const charge = task("charge", async () => { throw failure; });
  const compensate = vi.fn(async () => "refunded");
  const refund = task("refund", compensate);
  const workflow = entrypoint({ name: "workflow", checkpointer: checkpoint ? new MemorySaver() : undefined }, async () => {
    try { return await charge(); }
    catch (error) {
      expect(error).toBe(failure);
      return refund();
    }
  });
  await expect(workflow.invoke({}, { configurable: { thread_id: "recovery" } })).resolves.toBe("refunded");
  expect(compensate).toHaveBeenCalledTimes(1);
});

it("preserves the identity of an uncaught task failure", async () => {
  const failure = new TypeError("card declined");
  const charge = task("charge", async () => { throw failure; });
  const workflow = entrypoint({ name: "workflow" }, async () => charge());
  await expect(workflow.invoke({})).rejects.toBe(failure);
});

it("lets a caller recover from a task failure in a fan-out", async () => {
  const failure = new TypeError("card declined");
  const charge = task("charge", async () => { throw failure; });
  const lookup = task("lookup", async () => "account");
  const refund = task("refund", async () => "refunded");
  const workflow = entrypoint({ name: "workflow" }, async () => {
    try { return await Promise.all([charge(), lookup()]); }
    catch (error) {
      expect(error).toBe(failure);
      return refund();
    }
  });
  await expect(workflow.invoke({})).resolves.toBe("refunded");
});

it("still checkpoints and resumes an interrupt inside a called task", async () => {
  const ask = task("ask", async () => interrupt("approve?"));
  const workflow = entrypoint({ name: "workflow", checkpointer: new MemorySaver() }, async () => ask());
  const config = { configurable: { thread_id: "interrupt" } };
  await workflow.invoke({}, config);
  expect((await workflow.getState(config)).tasks.some((t) => t.interrupts.length > 0)).toBe(true);
  await expect(workflow.invoke(new Command({ resume: "yes" }), config)).resolves.toBe("yes");
});
