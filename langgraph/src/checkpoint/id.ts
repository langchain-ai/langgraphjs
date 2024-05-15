import { v1 } from "uuid";

export function uuid6(clockseq: number): string {
  const node = crypto.getRandomValues(new Uint8Array(6));
  const uuid1 = v1({ node, clockseq });
  return convert1to6(uuid1);
}

export function convert1to6(uuid1: string): string {
  // https://github.com/oittaa/uuid6-python/blob/main/src/uuid6/__init__.py#L81
  const hex = uuid1.replace(/-/g, "");
  const v6 = `${hex.slice(13, 16)}${hex.slice(8, 12)}${hex.slice(
    0,
    1
  )}-${hex.slice(1, 5)}-6${hex.slice(5, 8)}-${hex.slice(16, 20)}-${hex.slice(
    20
  )}`;
  return v6;
}
