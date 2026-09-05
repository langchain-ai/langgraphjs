import { describe, expect, it, vi } from "vitest";
import { RunnableLambda } from "@langchain/core/runnables";
import { FakeTracer } from "../tests/utils.js";
import { gatherIterator, RunnableCallable } from "../utils.js";
import { RunnableSeq } from "./runnable.js";
import { omitPayload } from "./utils/index.js";

describe("RunnableSeq tracing", () => {
  it.each([42, [1, 2], null, undefined, new Date("2026-01-01")])(
    "passes raw input/output values to processors: %s",
    async (value) => {
      const processInputs = vi.fn(() => "summarized input");
      const processOutputs = vi.fn(() => null);
      const tracer = new FakeTracer();
      const identity = new RunnableCallable({
        func: (input: unknown) => input,
        trace: false,
      });
      const sequence = new RunnableSeq({
        first: identity,
        last: identity,
        tracePolicy: { processInputs, processOutputs },
      });
      expect(await sequence.invoke(value, { callbacks: [tracer] })).toBe(value);
      expect(processInputs).toHaveBeenCalledExactlyOnceWith(value);
      expect(processOutputs).toHaveBeenCalledExactlyOnceWith(value);
      expect(tracer.runs[0].inputs).toEqual({ input: "summarized input" });
      expect(tracer.runs[0].outputs).toEqual({ output: null });
    }
  );

  it("streams original chunks and transforms the accumulated output once", async () => {
    const processOutputs = vi.fn(omitPayload);
    const tracer = new FakeTracer();
    const sequence = new RunnableSeq({
      first: new RunnableCallable({
        func: (input: string) => input,
        trace: false,
      }),
      last: RunnableLambda.from(async function* (input: string) {
        yield input;
        yield "!";
      }),
      tracePolicy: { processInputs: omitPayload, processOutputs },
    });
    expect(
      await gatherIterator(sequence.stream("hello", { callbacks: [tracer] }))
    ).toEqual(["hello", "!"]);
    expect(processOutputs).toHaveBeenCalledExactlyOnceWith("hello!");
    expect(tracer.runs[0].inputs).toEqual({});
    expect(tracer.runs[0].outputs).toEqual({});
    expect(tracer.runs[0].child_runs[0].outputs).toEqual({ output: "hello!" });
  });

  it("records stream errors without processing an incomplete output", async () => {
    const processOutputs = vi.fn(omitPayload);
    const tracer = new FakeTracer();
    const error = new Error("stream failed");
    const sequence = new RunnableSeq({
      first: new RunnableCallable({
        func: (input: string) => input,
        trace: false,
      }),
      last: RunnableLambda.from(async function* () {
        yield "partial";
        throw error;
      }),
      tracePolicy: { processOutputs },
    });
    await expect(
      gatherIterator(sequence.stream("input", { callbacks: [tracer] }))
    ).rejects.toBe(error);
    expect(processOutputs).not.toHaveBeenCalled();
    expect(tracer.runs[0].error).toContain("stream failed");
  });

  it("keeps concurrent batch payloads and errors associated with each input", async () => {
    const processInputs = vi.fn((input) => ({ summarized: input }));
    const processOutputs = vi.fn((output) => ({ summarized: output }));
    const tracer = new FakeTracer();
    const error = new Error("negative");
    const sequence = new RunnableSeq({
      first: new RunnableCallable({
        func: async (input: number) => {
          await Promise.resolve();
          if (input < 0) throw error;
          return input + 1;
        },
        trace: false,
      }),
      last: new RunnableCallable({
        func: (input: number) => input * 2,
        trace: false,
      }),
      tracePolicy: { processInputs, processOutputs },
    });
    expect(
      await sequence.batch(
        [1, -1, 3],
        { callbacks: [tracer], maxConcurrency: 2 },
        { returnExceptions: true }
      )
    ).toEqual([4, error, 8]);
    expect(processInputs).toHaveBeenCalledTimes(3);
    expect(processOutputs).toHaveBeenCalledTimes(2);
    for (const [input, output] of [
      [1, 4],
      [3, 8],
    ]) {
      const run = tracer.runs.find((run) => run.inputs.summarized === input);
      expect(run?.outputs).toEqual({ summarized: output });
    }
    expect(
      tracer.runs.find((run) => run.inputs.summarized === -1)?.error
    ).toContain("negative");
    expect(await sequence.batch([])).toEqual([]);
    await expect(sequence.batch([-1])).rejects.toBe(error);
  });

  it("honors cancellation before channel writers execute", async () => {
    const controller = new AbortController();
    const error = new Error("cancelled");
    const writer = vi.fn((input: number) => input);
    const processOutputs = vi.fn(omitPayload);
    const tracer = new FakeTracer();
    const sequence = new RunnableSeq({
      first: new RunnableCallable({
        func: (input: number) => {
          controller.abort(error);
          return input;
        },
        trace: false,
      }),
      last: new RunnableCallable({ func: writer, trace: false }),
      tracePolicy: { processInputs: omitPayload, processOutputs },
    });
    await expect(
      sequence.invoke(1, { signal: controller.signal, callbacks: [tracer] })
    ).rejects.toBe(error);
    expect(writer).not.toHaveBeenCalled();
    expect(processOutputs).not.toHaveBeenCalled();
    expect(tracer.runs[0].error).toContain("cancelled");
  });
});
