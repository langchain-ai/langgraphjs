import { watch } from "./bundler.mjs";
import * as fs from "node:fs/promises";
import * as url from "node:url";
import * as path from "node:path";

import { z } from "zod";

const cwd = process.cwd();

const defs = z
  .record(z.string(), z.string())
  .parse(JSON.parse(process.env.LANGGRAPH_UI || "{}"));

const config = z
  .object({ shared: z.array(z.string()).optional() })
  .parse(JSON.parse(process.env.LANGGRAPH_UI_CONFIG || "{}"));

const UI_DIR = url.fileURLToPath(new URL("../../ui", import.meta.url));

// clear the files in the ui directory
await fs.rm(UI_DIR, { recursive: true, force: true });

// watch the files in the ui directory
await Promise.all(
  Object.entries(defs).map(async ([graphId, userPath]) => {
    const folder = path.resolve(UI_DIR, graphId);
    await fs.mkdir(folder, { recursive: true });

    let promiseSeq = Promise.resolve();
    await watch(graphId, { cwd, userPath, config }, (files) => {
      promiseSeq = promiseSeq.then(
        async () => {
          await Promise.all(
            files.map(async ({ basename, contents }) => {
              const target = path.join(folder, basename);
              await fs.writeFile(target, contents);
            }),
          );
        },
        (e) => console.error(e),
      );
    });
  }),
);
