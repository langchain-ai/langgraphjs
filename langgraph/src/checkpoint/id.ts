import { v5, v6 } from "uuid";

export function uuid6(clockseq: number): string {
  return v6({ clockseq });
}

// Skip UUID validation check, since UUID6s
// generated with negative clockseq are not
// technically compliant, but still work.
// See: https://github.com/uuidjs/uuid/issues/511
export function uuid5(name: string, namespace: string): string {
  const namespaceBytes = namespace
    .replace(/-/g, "")
    .match(/.{2}/g)!
    .map((byte) => parseInt(byte, 16));
  return v5(name, new Uint8Array(namespaceBytes));
}
