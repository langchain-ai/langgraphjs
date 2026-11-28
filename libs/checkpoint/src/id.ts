import { v5, v6 } from "@langchain/core/utils/uuid";

// Monotonic timestamp state, mirroring uuid@10's internal v1 clock handling.
// uuid@11+ dropped the sub-millisecond `nsecs` counter when an explicit
// `clockseq` is provided, so successive `v6({ clockseq })` calls within the
// same millisecond produce identical time bits and would only be ordered by
// `clockseq`. Checkpoint IDs are sorted lexicographically, so we must keep the
// time component strictly increasing across calls to preserve checkpoint
// ordering regardless of the `clockseq` value passed in.
let lastMsecs = 0;
let lastNsecs = 0;

// UUID v6 timestamps are 100ns ticks since 1582-10-15.
const UUID_EPOCH_OFFSET = 0x01b21dd213814000n;
const UUID_TICKS_PER_MILLISECOND = 10_000n;

function uuid6UnixTicks(id: string): bigint | undefined {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "6") return undefined;

  const timestamp = BigInt(`0x${hex.slice(0, 12)}${hex.slice(13, 16)}`);
  return timestamp - UUID_EPOCH_OFFSET;
}

export function uuid6(clockseq: number, afterId?: string): string {
  let msecs = Date.now();
  if (msecs <= lastMsecs) {
    // Clock did not advance; bump the 100ns-resolution counter so the
    // generated time bits remain strictly monotonic.
    msecs = lastMsecs;
    lastNsecs += 1;
    if (lastNsecs >= 10000) {
      lastNsecs = 0;
      msecs = lastMsecs + 1;
    }
  } else {
    lastNsecs = 0;
  }

  // A process-local counter cannot order checkpoints created by another
  // process. Never mint a checkpoint ID at or before the checkpoint it
  // continues, even if this process has a clock that is behind its parent.
  const parentTicks = afterId ? uuid6UnixTicks(afterId) : undefined;
  if (parentTicks !== undefined) {
    const nextTicks =
      BigInt(msecs) * UUID_TICKS_PER_MILLISECOND + BigInt(lastNsecs);
    if (nextTicks <= parentTicks) {
      const clampedTicks = parentTicks + 1n;
      msecs = Number(clampedTicks / UUID_TICKS_PER_MILLISECOND);
      lastNsecs = Number(clampedTicks % UUID_TICKS_PER_MILLISECOND);
    }
  }

  lastMsecs = msecs;
  return v6({ clockseq, msecs, nsecs: lastNsecs });
}

export function uuid5(name: string, namespace: string): string {
  const namespaceBytes = namespace
    .replace(/-/g, "")
    .match(/.{2}/g)!
    .map((byte) => parseInt(byte, 16));
  return v5(name, new Uint8Array(namespaceBytes));
}
