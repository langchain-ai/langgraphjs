import { Hono } from "hono";
import * as path from "node:path";
import * as url from "node:url";

export async function registerHttp(appPath: string, options: { cwd: string }) {
  const [userFile, exportSymbol] = appPath.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  const user = (await import(url.pathToFileURL(sourceFile).toString()).then(
    (module) => module[exportSymbol || "default"],
  )) as Hono | undefined;

  if (!user) throw new Error(`Failed to load HTTP app: ${appPath}`);
  return { api: user };
}
