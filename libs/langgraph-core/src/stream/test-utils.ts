import type { Namespace, ProtocolEvent } from "./types.js";

export interface MakeProtocolEventOptions {
  namespace?: Namespace;
  data?: unknown;
  node?: string;
  seq?: number;
}

export function makeProtocolEvent(
  method: string,
  options: MakeProtocolEventOptions = {}
): ProtocolEvent {
  const { namespace = [], data = {}, node, seq = 0 } = options;
  return {
    type: "event",
    seq,
    method: method as ProtocolEvent["method"],
    params: {
      namespace,
      timestamp: Date.now(),
      data,
      ...(node != null ? { node } : {}),
    },
  };
}

export async function collectIterator<T>(iter: AsyncIterator<T>): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const result = await iter.next();
    if (result.done) break;
    items.push(result.value);
  }
  return items;
}

export async function collectAsyncIterable<T>(
  iter: AsyncIterable<T>
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}
