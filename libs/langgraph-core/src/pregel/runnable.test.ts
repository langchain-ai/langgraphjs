import { describe, expect, it, vi } from "vitest";
import { RunnableLambda, RunnableSequence } from "@langchain/core/runnables";
import { FakeTracer } from "../tests/utils.js";
import { gatherIterator, RunnableCallable } from "../utils.js";
import { RunnableSeq } from "./runnable.js";
import { omitPayload } from "./utils/index.js";

describe("RunnableSeq tracing", () => {
  it.each([{}, { processInputs: omitPayload, processOutputs: omitPayload }])(
    "preserves child batch implementations with policy %s",
    async (tracePolicy) => {
      const firstInvoke = vi.fn((input: number) => input);
      const middleInvoke = vi.fn((input: number) => input);
      const lastInvoke = vi.fn((input: number) => input);
      const first = new RunnableCallable<number, number>({
        func: firstInvoke,
        trace: false,
      });
      const middle = new RunnableCallable<number, number>({
        func: middleInvoke,
        trace: false,
      });
      const last = new RunnableCallable<number, number>({
        func: lastInvoke,
        trace: false,
      });
      const firstBatch = vi
        .spyOn(first, "batch")
        .mockImplementation(async (inputs) =>
          inputs.map((value) => value + 100)
        );
      const middleBatch = vi
        .spyOn(middle, "batch")
        .mockImplementation(async (inputs) => inputs.map((value) => value * 2));
      const lastBatch = vi
        .spyOn(last, "batch")
        .mockImplementation(async (inputs) => inputs.map((value) => value - 3));
      const fields = { first, middle: [middle], last, omitSequenceTags: true };
      const expected = await new RunnableSequence(fields).batch([1, 2]);
      for (const mock of [firstBatch, middleBatch, lastBatch]) mock.mockClear();

      const tracer = new FakeTracer();
      tracer.awaitHandlers = true;
      const controller = new AbortController();
      const options = [1, 2].map((id) => ({
        callbacks: [tracer],
        configurable: { id },
        tags: ["batch-tag"],
        signal: controller.signal,
      }));
      const batchOptions = {
        maxConcurrency: 2,
        returnExceptions: true,
      } as const;
      const sequence = new RunnableSeq({ ...fields, tracePolicy });
      expect(await sequence.batch([1, 2], options, batchOptions)).toEqual(
        expected
      );
      expect(expected).toEqual([199, 201]);
      expect(firstBatch).toHaveBeenCalledExactlyOnceWith(
        [1, 2],
        expect.any(Array),
        batchOptions
      );
      expect(middleBatch).toHaveBeenCalledExactlyOnceWith(
        [101, 102],
        expect.any(Array),
        batchOptions
      );
      expect(lastBatch).toHaveBeenCalledExactlyOnceWith(
        [202, 204],
        expect.any(Array),
        batchOptions
      );
      for (const mock of [firstInvoke, middleInvoke, lastInvoke])
        expect(mock).not.toHaveBeenCalled();
      for (const mock of [firstBatch, middleBatch, lastBatch]) {
        expect(mock.mock.calls[0][1]).toEqual(
          [1, 2].map((id, index) =>
            expect.objectContaining({
              configurable: { id },
              signal: controller.signal,
              callbacks: expect.objectContaining({
                _parentRunId: tracer.runs[index].id,
              }),
            })
          )
        );
      }
      expect(tracer.runs.map((run) => run.inputs)).toEqual(
        tracePolicy.processInputs ? [{}, {}] : [{ input: 1 }, { input: 2 }]
      );
      expect(tracer.runs.map((run) => run.outputs)).toEqual(
        tracePolicy.processOutputs
          ? [{}, {}]
          : [{ output: 199 }, { output: 201 }]
      );
    }
  );

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
    tracer.awaitHandlers = true;
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
        // With returnExceptions, Core passes exceptions returned by earlier
        // batches to the following step. Preserve that contract here too.
        func: (input: number | Error) =>
          typeof input === "number" ? input * 2 : input,
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
    expect(processOutputs).toHaveBeenCalledTimes(3);
    for (const [input, output] of [
      [1, 4],
      [3, 8],
    ]) {
      const run = tracer.runs.find((run) => run.inputs.summarized === input);
      expect(run?.outputs).toEqual({ summarized: output });
    }
    expect(
      tracer.runs.find((run) => run.inputs.summarized === -1)?.outputs
    ).toEqual({ summarized: error });
    expect(await sequence.batch([])).toEqual([]);
    await expect(sequence.batch([-1])).rejects.toBe(error);
  });

  it("reports a rejected child batch on every sequence run", async () => {
    const error = new Error("batch failed");
    const processOutputs = vi.fn(omitPayload);
    const first = new RunnableCallable({
      func: (input: number) => input,
      trace: false,
    });
    vi.spyOn(first, "batch").mockRejectedValue(error);
    const last = new RunnableCallable({
      func: (input: number) => input,
      trace: false,
    });
    const lastBatch = vi.spyOn(last, "batch");
    const tracer = new FakeTracer();
    tracer.awaitHandlers = true;
    const sequence = new RunnableSeq({
      first,
      last,
      tracePolicy: { processOutputs },
    });

    await expect(sequence.batch([1, 2], { callbacks: [tracer] })).rejects.toBe(
      error
    );
    expect(lastBatch).not.toHaveBeenCalled();
    expect(processOutputs).not.toHaveBeenCalled();
    expect(tracer.runs).toHaveLength(2);
    for (const run of tracer.runs) expect(run.error).toContain("batch failed");
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
