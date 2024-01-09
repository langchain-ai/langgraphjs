import { BaseChannel } from "../channels/index.js";

export function validateGraph({
  nodes,
  chammels,
  input,
  output
}: {
  nodes: Record<string, ChannelInvoke | ChannelBatch>;
  chammels: { [key: string]: BaseChannel<unknown, unknown, unknown> };
  input: string | Array<string>;
  output: string | Array<string>;
}): void {
  // @TODO implement ChannelInvoke & ChannelBatch first.
}
