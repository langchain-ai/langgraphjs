#!/usr/bin/env bun
function $(strings, ...rest) {
  process.stderr.write(
    ["$", ...strings.raw].map((i) => String(i)).join(" ") + "\n"
  );
  return Bun.$(strings, ...rest);
}

await $`rm -rf dist`;
await $`yarn tsc --outDir dist`;

await $`mv dist/src/* dist`;
await $`rm -rf dist/src dist/tests`;
