import type { CallbackManagerForChainRun } from "@langchain/core/callbacks/manager";
import {
  ensureConfig,
  getCallbackManagerForConfig,
  patchConfig,
  raceWithSignal,
  RunnableSequence,
  type RunnableBatchOptions,
  type RunnableConfig,
} from "@langchain/core/runnables";
import { _coerceToDict, type TracePolicy } from "./utils/index.js";

function tracePayload(
  value: unknown,
  processor: ((value: unknown) => unknown) | undefined
): unknown {
  if (processor === undefined) return value;
  try {
    return processor(value);
  } catch (error) {
    console.warn(
      "Trace input/output processor raised; recording untransformed payload",
      error
    );
    return value;
  }
}

/**
 * A node sequence with transforms at its own tracing boundaries. Keep execution
 * and child callback propagation aligned with Core's RunnableSequence; only the
 * values passed to handleChainStart/handleChainEnd are transformed.
 * @internal
 */
export class RunnableSeq<
  RunInput = unknown,
  RunOutput = unknown,
> extends RunnableSequence<RunInput, RunOutput> {
  private tracePolicy?: TracePolicy;

  constructor(
    fields: ConstructorParameters<
      typeof RunnableSequence<RunInput, RunOutput>
    >[0] & {
      tracePolicy?: TracePolicy;
    }
  ) {
    const { tracePolicy, ...sequenceFields } = fields;
    super(sequenceFields);
    this.tracePolicy = tracePolicy;
  }

  private async startTrace(input: RunInput, config: RunnableConfig) {
    // Evaluate outside optional chaining: processors run without callbacks too.
    const payload = tracePayload(input, this.tracePolicy?.processInputs);
    const manager = await getCallbackManagerForConfig(config);
    return manager?.handleChainStart(
      this.toJSON(),
      _coerceToDict(payload, "input"),
      config.runId,
      undefined,
      undefined,
      undefined,
      config.runName
    );
  }

  private async endTrace(
    output: unknown,
    manager: CallbackManagerForChainRun | undefined
  ) {
    const payload = tracePayload(output, this.tracePolicy?.processOutputs);
    await manager?.handleChainEnd(_coerceToDict(payload, "output"));
  }

  override async invoke(
    input: RunInput,
    options?: RunnableConfig
  ): Promise<RunOutput> {
    const config = ensureConfig(options);
    const manager = await this.startTrace(input, config);
    delete config.runId;
    let nextInput = input;
    let output: RunOutput;
    try {
      const steps = [this.first, ...this.middle];
      for (let i = 0; i < steps.length; i += 1) {
        nextInput = await raceWithSignal(
          steps[i].invoke(
            nextInput,
            patchConfig(config, {
              callbacks: manager?.getChild(
                this.omitSequenceTags ? undefined : `seq:step:${i + 1}`
              ),
            })
          ),
          config.signal
        );
      }
      if (config.signal?.aborted) {
        // Use Core's abort-error normalization before invoking the last step.
        await raceWithSignal(Promise.resolve(), config.signal);
      }
      output = await this.last.invoke(
        nextInput,
        patchConfig(config, {
          callbacks: manager?.getChild(
            this.omitSequenceTags ? undefined : `seq:step:${this.steps.length}`
          ),
        })
      );
    } catch (error) {
      await manager?.handleChainError(error);
      throw error;
    }
    await this.endTrace(output, manager);
    return output;
  }

  override batch(
    inputs: RunInput[],
    options?: Partial<RunnableConfig> | Partial<RunnableConfig>[],
    batchOptions?: RunnableBatchOptions & { returnExceptions?: false }
  ): Promise<RunOutput[]>;
  override batch(
    inputs: RunInput[],
    options?: Partial<RunnableConfig> | Partial<RunnableConfig>[],
    batchOptions?: RunnableBatchOptions & { returnExceptions: true }
  ): Promise<(RunOutput | Error)[]>;
  override batch(
    inputs: RunInput[],
    options?: Partial<RunnableConfig> | Partial<RunnableConfig>[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]>;
  override async batch(
    inputs: RunInput[],
    options?: Partial<RunnableConfig> | Partial<RunnableConfig>[],
    batchOptions?: RunnableBatchOptions
  ): Promise<(RunOutput | Error)[]> {
    const configList = this._getOptionsList(options ?? {}, inputs.length);
    const managers = await Promise.all(
      configList.map(async (config, i) => {
        const manager = await this.startTrace(inputs[i], config);
        delete config.runId;
        return manager;
      })
    );
    let outputs: unknown[] = inputs;
    try {
      // Preserve RunnableSequence's step-wise batching so child runnables can
      // use their native batch implementations and handle returnExceptions.
      for (let i = 0; i < this.steps.length; i += 1) {
        outputs = await raceWithSignal(
          this.steps[i].batch(
            outputs,
            managers.map((manager, j) =>
              patchConfig(configList[j], {
                callbacks: manager?.getChild(
                  this.omitSequenceTags ? undefined : `seq:step:${i + 1}`
                ),
              })
            ),
            batchOptions
          ),
          configList[0]?.signal
        );
      }
    } catch (error) {
      await Promise.all(
        managers.map((manager) => manager?.handleChainError(error))
      );
      throw error;
    }
    await Promise.all(
      managers.map((manager, i) => this.endTrace(outputs[i], manager))
    );
    return outputs as (RunOutput | Error)[];
  }

  override async *_streamIterator(input: RunInput, options?: RunnableConfig) {
    const config = ensureConfig(options);
    const manager = await this.startTrace(input, config);
    delete config.runId;
    const steps = this.steps;
    let output: RunOutput | undefined;
    let concatSupported = true;
    async function* inputGenerator() {
      yield input;
    }
    try {
      let generator = steps[0].transform(
        inputGenerator(),
        patchConfig(config, {
          callbacks: manager?.getChild(
            this.omitSequenceTags ? undefined : "seq:step:1"
          ),
        })
      );
      for (let i = 1; i < steps.length; i += 1) {
        generator = steps[i].transform(
          generator,
          patchConfig(config, {
            callbacks: manager?.getChild(
              this.omitSequenceTags ? undefined : `seq:step:${i + 1}`
            ),
          })
        );
      }
      for await (const chunk of generator) {
        config.signal?.throwIfAborted();
        yield chunk as RunOutput;
        if (concatSupported) {
          if (output === undefined) output = chunk;
          else {
            try {
              output = this._concatOutputChunks(output, chunk);
            } catch {
              output = undefined;
              concatSupported = false;
            }
          }
        }
      }
    } catch (error) {
      await manager?.handleChainError(error);
      throw error;
    }
    await this.endTrace(output, manager);
  }
}
