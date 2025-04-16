import { Client } from "@langchain/langgraph-sdk";
import { LOOPBACK_FETCH } from "../loopback.mjs";
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

  const api = new Hono<{ Variables: { langgraph: Client } }>();
  const client = new Client<any>({
    apiUrl: "http://localhost:2024",
    callerOptions: { fetch: LOOPBACK_FETCH },
  });

  api.use(async (c, next) => {
    c.set("langgraph", client);
    await next();
  });
  api.route("/", user);

  return { api };
}
