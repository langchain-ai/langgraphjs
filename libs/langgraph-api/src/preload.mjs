import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// arguments passed to the entrypoint: [ppid, payload]
// we only care about the payload, which contains the server definition
const lastArg = process.argv.at(-1);
const options = JSON.parse(lastArg || "{}");

// find the first file, as `parentURL` needs to be a valid file URL
// if no graph found, just assume a dummy default file, which should
// be working fine as well.
const firstGraphFile =
  Object.values(options.graphs)
    .flatMap((i) => i.split(":").at(0))
    .at(0) || "index.mts";

// enforce API @langchain/langgraph resolution
register("./graph/load.hooks.mjs", import.meta.url, {
  parentURL: "data:",
  data: {
    parentURL: pathToFileURL(join(options.cwd, firstGraphFile)).toString(),
  },
});
