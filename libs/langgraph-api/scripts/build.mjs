#!/usr/bin/env bun
import { $ } from "./utils.mjs";

await $`rm -rf dist`;
await $`pnpm tsc --outDir dist`;

await Promise.all([
  $`pnpm tsc --module nodenext --outDir dist/src/cli -d src/cli/spawn.mts`,
  $`pnpm tsc --module nodenext --outDir dist/src/auth -d src/auth/index.mts`,
  $`pnpm tsc --module nodenext --outDir dist/src/semver -d src/semver/index.mts`,
]);

await $`cp src/graph/parser/schema/types.template.mts dist/src/graph/parser/schema`;
await $`rm -rf dist/src/graph/parser/schema/types.template.mjs`;

await $`mv dist/src/* dist`;
await $`rm -rf dist/src dist/tests`;
