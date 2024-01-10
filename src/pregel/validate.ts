import { BaseChannel } from "../channels/index.js";
import { ChannelBatch, ChannelInvoke } from "./read.js";

export function validateGraph({
  nodes,
  channels,
  input,
  output,
}: {
  nodes: Record<string, ChannelInvoke | ChannelBatch>;
  channels: { [key: string]: BaseChannel };
  input: string | Array<string>;
  output: string | Array<string>;
}): void {
  // @TODO implement ChannelInvoke & ChannelBatch first.
}
