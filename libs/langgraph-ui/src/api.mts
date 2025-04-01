import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as bundler from "./bundler.mjs";

function getBuildContext(options: { output: string }) {
  const cwd = process.cwd();
  const defs = z
    .record(z.string(), z.string())
    .parse(JSON.parse(process.env.LANGGRAPH_UI || "{}"));

  const config = z
    .object({ shared: z.array(z.string()).optional() })
    .parse(JSON.parse(process.env.LANGGRAPH_UI_CONFIG || "{}"));

  const fullPath = path.resolve(cwd, options.output);
  const publicPath = path.resolve(fullPath, "public");
  const schemasPath = path.resolve(fullPath, "schemas.json");

  return { cwd, defs, config, publicPath, schemasPath };
}

export async function build(options: { output: string }) {
  const { cwd, defs, config, publicPath, schemasPath } =
    getBuildContext(options);

  const schemas: Record<string, { assets: string[]; name: string }> = {};

  await Promise.all(
    Object.entries(defs).map(async ([graphId, userPath]) => {
      const folder = path.resolve(publicPath, graphId);
      await fs.mkdir(folder, { recursive: true });

      const files = await bundler.build(graphId, { userPath, cwd, config });
      await Promise.all(
        files.map(async (item) => {
          const target = path.resolve(folder, item.basename);
          await fs.writeFile(target, item.contents);

          schemas[graphId] ??= { assets: [], name: graphId };
          schemas[graphId].assets.push(path.relative(folder, target));
        }),
      );
    }),
  );

  await fs.writeFile(schemasPath, JSON.stringify(schemas), {
    encoding: "utf-8",
  });
}

export async function watch(options: { output: string }) {
  const { cwd, defs, config, publicPath, schemasPath } =
    getBuildContext(options);

  const schemas: Record<string, { assets: string[]; name: string }> = {};
  let promiseSeq = Promise.resolve();

  await Promise.all(
    Object.entries(defs).map(async ([graphId, userPath]) => {
      const folder = path.resolve(publicPath, graphId);
      await fs.mkdir(folder, { recursive: true });

      await bundler.watch(graphId, { cwd, userPath, config }, (files) => {
        promiseSeq = promiseSeq.then(
          async () => {
            await Promise.all(
              files.map(async ({ basename, contents }) => {
                const target = path.resolve(folder, basename);
                await fs.writeFile(target, contents);

                schemas[graphId] ??= { assets: [], name: graphId };
                schemas[graphId].assets.push(path.relative(folder, target));
              }),
            );

            await fs.writeFile(schemasPath, JSON.stringify(schemas), {
              encoding: "utf-8",
            });
          },
          (e) => console.error(e),
        );
      });
    }),
  );
}
