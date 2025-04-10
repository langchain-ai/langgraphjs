#!/usr/bin/env bun
import { parseArgs } from "util";
import { $ } from "./utils.mjs";

const { values, positionals } = parseArgs({
  options: { config: { short: "c", type: "string" } },
  allowPositionals: true,
});

await $`rm -rf tests/graphs/.langgraph_api`;
await Promise.race([
  $`pnpm tsx ./tests/utils.server.mts ${values.config}`,
  (async () => {
    await $`bun x wait-port -t 24000 localhost:2024`;
    await $`pnpm vitest run ${positionals}`;
    process.exit(0);
  })(),
]);
