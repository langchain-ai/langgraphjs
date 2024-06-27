import { v6 } from "uuid";

export function uuid6(clockseq: number): string {
  return v6({ clockseq });
}
