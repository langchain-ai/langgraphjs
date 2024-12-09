import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";
import { RunnableConfig } from "@langchain/core/runnables";
import { GraphInterrupt } from "./errors.js";
import {
  CONFIG_KEY_CHECKPOINT_NS,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_TASK_ID,
  CONFIG_KEY_WRITES,
  CONFIG_KEY_SEND,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  NULL_TASK_ID,
  RESUME,
} from "./constants.js";
import { PregelScratchpad } from "./pregel/types.js";

export function interrupt<I = unknown, R = unknown>(value: I): R {
  const config: RunnableConfig | undefined =
    AsyncLocalStorageProviderSingleton.getRunnableConfig();
  if (!config) {
    throw new Error("Called interrupt() outside the context of a graph.");
  }

  // Track interrupt index
  const scratchpad: PregelScratchpad<R> =
    config.configurable?.[CONFIG_KEY_SCRATCHPAD];
  if (scratchpad.interruptCounter === undefined) {
    scratchpad.interruptCounter = 0;
  } else {
    scratchpad.interruptCounter += 1;
  }
  const idx = scratchpad.interruptCounter;

  // Find previous resume values
  const taskId = config.configurable?.[CONFIG_KEY_TASK_ID];
  const writes: CheckpointPendingWrite[] =
    config.configurable?.[CONFIG_KEY_WRITES] ?? [];

  if (!scratchpad.resume) {
    const newResume = (writes.find((w) => w[0] === taskId && w[1] === RESUME)?.[2] ||
      []) as R | R[];
    scratchpad.resume = Array.isArray(newResume) ? newResume : [newResume];
  }

  if (scratchpad.resume) {
    if (idx < scratchpad.resume.length) {
      return scratchpad.resume[idx];
    }
  }

  // Find current resume value
  if (!scratchpad.usedNullResume) {
    scratchpad.usedNullResume = true;
    const sortedWrites = [...writes].sort(
      (a, b) => b[0].localeCompare(a[0]) // Sort in reverse order
    );

    for (const [tid, c, v] of sortedWrites) {
      if (tid === NULL_TASK_ID && c === RESUME) {
        if (scratchpad.resume.length !== idx) {
          throw new Error(
            `Resume length mismatch: ${scratchpad.resume.length} !== ${idx}`
          );
        }
        scratchpad.resume.push(v as R);
        const send = config.configurable?.[CONFIG_KEY_SEND];
        if (send) {
          send([[RESUME, scratchpad.resume]]);
        }
        return v as R;
      }
    }
  }

  // No resume value found
  throw new GraphInterrupt([
    {
      value,
      when: "during",
      resumable: true,
      ns: config.configurable?.[CONFIG_KEY_CHECKPOINT_NS]?.split(
        CHECKPOINT_NAMESPACE_SEPARATOR
      ),
    },
  ]);
}
