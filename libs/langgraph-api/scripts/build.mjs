#!/usr/bin/env bun
function $(strings, ...rest) {
  process.stderr.write(
    ["$", ...strings.raw].map((i) => String(i)).join(" ") + "\n",
  );
  return Bun.$(strings, ...rest);
}

await $`rm -rf dist`;
await $`pnpm tsc --outDir dist`;
await $`pnpm tsc --module nodenext --outDir dist/src/cli -d src/cli/spawn.mts`;
await $`pnpm tsc --module nodenext --outDir dist/src/ui -d src/ui/bundler.mts`;

await $`cp src/graph/parser/schema/types.template.mts dist/src/graph/parser/schema`;
await $`rm -rf dist/src/graph/parser/schema/types.template.mjs`;

await $`cp src/ui/render.template.mts dist/src/ui`;
await $`rm -rf dist/src/ui/render.template.mjs`;

await $`mv dist/src/* dist`;
await $`rm -rf dist/src dist/tests`;
