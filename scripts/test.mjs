#!/bin/bash
import "./build.mjs";
await spinner("Clearing API", () => fs.remove("tests/graphs/.langgraph_api"));

const server = `node dist/cli/cli.mjs dev --no-browser --config ./tests/graphs/langgraph.json`;
const test = `npx -y wait-port -t 3000 localhost:9123 && vitest run`;

await $`npx -y concurrently -k -s "command-test" -n "server,test" ${server} ${test}`;
