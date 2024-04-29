import { BaseChannel } from "../channels/index.js";
import { INTERRUPT } from "../constants.js";
import { PregelNode } from "./read.js";

export class GraphValidationError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export function validateGraph({
  nodes,
  channels,
  inputChannels,
  outputChannels,
  streamChannels,
  interruptAfterNodes,
  interruptBeforeNodes,
  defaultChannelFactory,
}: {
  nodes: Record<string, PregelNode>;
  channels: { [key: string]: BaseChannel };
  inputChannels: string | Array<string>;
  outputChannels: string | Array<string>;
  streamChannels?: string | Array<string>;
  interruptAfterNodes: Array<string>;
  interruptBeforeNodes: Array<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultChannelFactory: () => any;
}): void {
  const newChannels = channels;
  const subscribedChannels = new Set<string>();
  const allOutputChannels = new Set<string>();

  for (const [name, node] of Object.entries(nodes)) {
    if (name === INTERRUPT) {
      throw new GraphValidationError(`"Node name ${INTERRUPT} is reserved"`);
    }
    if (node.constructor === PregelNode) {
      node.triggers.forEach((trigger) => subscribedChannels.add(trigger));
    } else {
      throw new GraphValidationError(
        `Invalid node type ${typeof node}, expected PregelNode`
      );
    }
  }

  // side effect: update channels
  for (const chan of subscribedChannels) {
    if (!(chan in newChannels)) {
      newChannels[chan] = defaultChannelFactory();
    }
  }

  if (typeof inputChannels === "string") {
    if (!subscribedChannels.has(inputChannels)) {
      throw new GraphValidationError(
        `Input channel ${inputChannels} is not subscribed to by any node`
      );
    }
  } else {
    if (inputChannels.every((channel) => !subscribedChannels.has(channel))) {
      throw new GraphValidationError(
        `None of the input channels ${inputChannels} are subscribed to by any node`
      );
    }
  }

  // side effect: update channels
  if (typeof outputChannels === "string") {
    allOutputChannels.add(outputChannels);
  } else {
    outputChannels.forEach((chan) => allOutputChannels.add(chan));
  }

  if (typeof streamChannels === "string") {
    allOutputChannels.add(streamChannels);
  } else if (streamChannels) {
    streamChannels.forEach((chan) => allOutputChannels.add(chan));
  }

  for (const chan of allOutputChannels) {
    if (!(chan in newChannels)) {
      newChannels[chan] = defaultChannelFactory();
    }
  }

  // validate interrupt before/after
  for (const node of interruptAfterNodes) {
    if (!(node in nodes)) {
      throw new GraphValidationError(`Node ${node} not in nodes`);
    }
  }

  for (const node of interruptBeforeNodes) {
    if (!(node in nodes)) {
      throw new GraphValidationError(`Node ${node} not in nodes`);
    }
  }
}

export function validateKeys(
  keys: string | Array<string>,
  channels: { [key: string]: BaseChannel }
): void {
  if (Array.isArray(keys)) {
    for (const key of keys) {
      if (!(key in channels)) {
        throw new Error(`Key ${key} not found in channels`);
      }
    }
  } else {
    if (!(keys in channels)) {
      throw new Error(`Key ${keys} not found in channels`);
    }
  }
}
