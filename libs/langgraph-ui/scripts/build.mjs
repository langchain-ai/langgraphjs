#!/usr/bin/env bun
function $(strings, ...rest) {
  process.stderr.write(
    ["$", ...strings.raw].map((i) => String(i)).join(" ") + "\n"
  );
  return Bun.$(strings, ...rest);
}

await $`rm -rf dist`;
await $`yarn tsc --outDir dist`;

await $`cp src/render.template.mts dist`;
await $`rm -rf dist/render.template.mjs dist/render.template.d.mts dist/cli.d.mts`;
