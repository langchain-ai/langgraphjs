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

export function uuid6(clockseq: number): string {
  let msecs = Date.now();
  if (msecs <= lastMsecs) {
    // Clock did not advance; bump the 100ns-resolution counter so the
    // generated time bits remain strictly monotonic.
    lastNsecs += 1;
    if (lastNsecs >= 10000) {
      lastNsecs = 0;
      msecs = lastMsecs + 1;
    }
  } else {
    lastNsecs = 0;
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
