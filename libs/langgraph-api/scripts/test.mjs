#!/usr/bin/env bun
function $(strings, ...rest) {
  process.stderr.write(
    ["$", ...strings.raw].map((i) => String(i)).join(" ") + "\n",
  );
  return Bun.$(strings, ...rest);
}

await $`rm -rf tests/graphs/.langgraph_api`;

await Promise.race([
  $`pnpm tsx ./tests/utils.server.mts`,
  (async () => {
    await $`bun x wait-port -t 24000 localhost:2024`;
    await $`pnpm vitest run --exclude ./tests/parser.test.mts"`;
    process.exit(0);
  })(),
]);
