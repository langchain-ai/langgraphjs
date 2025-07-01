import * as fs from "node:fs/promises";
import * as url from "node:url";

async function getVersion() {
  try {
    const packageJson = url.fileURLToPath(
      new URL("../../package.json", import.meta.url)
    );
    const { version } = JSON.parse(await fs.readFile(packageJson, "utf-8"));
    return version;
  } catch {
    return "0.0.0-unknown";
  }
}

export const version = await getVersion();
