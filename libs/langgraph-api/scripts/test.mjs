#!/usr/bin/env bun
function $(strings, ...rest) {
  console.log("$", ...strings.raw);
  return Bun.$(strings, ...rest);
}

await import("./build.mjs");
await $`rm -rf tests/graphs/.langgraph_api`;

await Promise.race([
  $`pnpm tsx ./tests/utils.server.mts`,
  (async () => {
    await $`bun x wait-port -t 12000 localhost:2024`;
    await $`pnpm vitest run --exclude ./tests/parser.test.mts"`;
    process.exit(0);
  })(),
]);
