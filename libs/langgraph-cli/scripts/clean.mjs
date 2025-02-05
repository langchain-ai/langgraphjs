#!/usr/bin/env bun
function $(strings, ...rest) {
  console.log("$", ...strings.raw);
  return Bun.$(strings, ...rest);
}

await $`rm -rf dist`;
