import * as url from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function getProjectPath(key: string) {
  const configPathOrFile = key.startsWith("file://")
    ? url.fileURLToPath(key)
    : path.resolve(process.cwd(), key);

  const stat = await fs.stat(configPathOrFile);
  if (stat.isDirectory()) {
    return path.join(configPathOrFile, "langgraph.json");
  }
  return configPathOrFile;
}
