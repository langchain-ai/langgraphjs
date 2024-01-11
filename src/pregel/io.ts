import { BaseChannel } from "../channels/base.js";

/**
 * Map input chunk to a sequence of pending writes in the form [channel, value].
 */
export function* mapInput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunInput = any
>(
  inputChannels: string | Array<string>,
  chunk?: RunInput
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Generator<[string, any]> {
  if (typeof inputChannels === "string") {
    yield [inputChannels, chunk];
  } else {
    if (chunk && typeof chunk !== "object") {
      throw new Error(`Expected chunk to be an object, got ${typeof chunk}`);
    }
    for (const k in chunk) {
      if (inputChannels.includes(k)) {
        yield [k, chunk[k]];
      } else {
        console.warn(`Input channel ${k} not found in ${inputChannels}`);
      }
    }
  }
}

/**
 * Map pending writes (a list of [channel, value]) to output chunk.
 */
export function mapOutput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RunOutput = any
>(
  outputChannels: string | Array<string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pendingWrites: Array<[string, any]>,
  channels: Record<string, BaseChannel<RunOutput>>
): RunOutput | undefined {
  if (typeof outputChannels === "string") {
    if (pendingWrites.some(([chan, _]) => chan === outputChannels)) {
      return channels[outputChannels].get();
    }
  } else {
    const updated = pendingWrites
      .filter(([chan, _]) => outputChannels.includes(chan))
      .map(([chan, _]) => chan);
    if (updated.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return updated.reduce((acc: Record<string, any>, chan) => {
        acc[chan] = channels[chan].get();
        return acc;
      }, {}) as RunOutput;
    }
  }
  return undefined;
}
