#!/usr/bin/env bun
function $(strings, ...rest) {
  console.log("$", ...strings.raw);
  return Bun.$(strings, ...rest);
}

await $`rm -rf dist`;
await $`pnpm tsc --outDir dist`;

await $`mv dist/src/* dist`;
await $`rm -rf dist/src dist/tests`;
