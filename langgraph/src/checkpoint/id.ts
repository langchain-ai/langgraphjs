import { v6 } from "uuid";

export function uuid6(clockseq: number): string {
  const node = crypto.getRandomValues(new Uint8Array(6));

  return v6({ node, clockseq });
}
