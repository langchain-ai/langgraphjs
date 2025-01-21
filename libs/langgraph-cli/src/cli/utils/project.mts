import * as url from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function getProjectPath(key: string) {
  const configPathOrFile = key.startsWith("file://")
    ? url.fileURLToPath(key)
    : path.resolve(process.cwd(), key);

  let configPath: string | undefined = undefined;
  if ((await fs.stat(configPathOrFile)).isDirectory()) {
    configPath = path.join(configPathOrFile, "langgraph.json");
  } else if (path.basename(configPathOrFile) === "langgraph.json") {
    configPath = configPathOrFile;
  }
  if (!configPath) throw new Error("Invalid path");
  return configPath;
}
