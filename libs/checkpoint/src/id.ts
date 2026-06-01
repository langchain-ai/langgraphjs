import { v5, v6 } from "uuid";

export function uuid6(clockseq: number): string {
  return v6({ clockseq });
}

// Negative clockseq values are not RFC-compliant but still accepted by uuid.
// Avoid them for checkpoint IDs: uuid@14+ no longer preserves sort order between
// negative and positive clockseq values.
export function uuid5(name: string, namespace: string): string {
  const namespaceBytes = namespace
    .replace(/-/g, "")
    .match(/.{2}/g)!
    .map((byte) => parseInt(byte, 16));
  return v5(name, new Uint8Array(namespaceBytes));
}
