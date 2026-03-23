import { Hono } from "hono";
import * as path from "node:path";
import * as url from "node:url";

async function loadApp(
  appPath: string,
  options: { cwd: string }
): Promise<Hono> {
  const [userFile, exportSymbol] = appPath.split(":", 2);

  let module: Record<string, unknown>;
  if (userFile.startsWith(".") || path.isAbsolute(userFile)) {
    const sourceFile = path.resolve(options.cwd, userFile);
    module = await import(url.pathToFileURL(sourceFile).toString());
  } else {
    module = await import(userFile);
  }

  const user = module[exportSymbol || "default"] as Hono | undefined;
  if (!user) throw new Error(`Failed to load HTTP app: ${appPath}`);
  return user;
}

export async function registerHttp(appPath: string, options: { cwd: string }) {
  const api = await loadApp(appPath, options);
  return { api };
}

export async function registerHttpApps(
  apps: Record<string, string>,
  options: { cwd: string }
): Promise<Array<{ prefix: string; api: Hono }>> {
  const results: Array<{ prefix: string; api: Hono }> = [];

  for (const [prefix, appPath] of Object.entries(apps)) {
    const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
    const api = await loadApp(appPath, options);
    results.push({ prefix: normalizedPrefix, api });
  }

  return results;
}
