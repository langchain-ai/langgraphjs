import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as bundler from "./bundler.mjs";

const ConfigSchema = z.object({ shared: z.array(z.string()).optional() });
const DefsSchema = z.record(z.string(), z.string());

type SchemasType = Record<string, { assets: string[]; name: string }>;

interface BuildEnvType {
  cwd?: string;
  defs?: z.infer<typeof DefsSchema>;
  config?: z.infer<typeof ConfigSchema>;
}

function getBuildEnv(options?: BuildEnvType) {
  const cwd = options?.cwd ?? process.cwd();

  const defs =
    options?.defs ??
    DefsSchema.parse(JSON.parse(process.env.LANGGRAPH_UI || "{}"));

  const config =
    options?.config ??
    ConfigSchema.parse(JSON.parse(process.env.LANGGRAPH_UI_CONFIG || "{}"));

  return { cwd, defs, config };
}

interface BuildOptionsType extends BuildEnvType {
  output: string;
}

export async function build(options: BuildOptionsType) {
  const { cwd, defs, config } = getBuildEnv(options);

  const fullPath = path.resolve(cwd, options.output);
  const publicPath = path.resolve(fullPath, "public");
  const schemasPath = path.resolve(fullPath, "schemas.json");

  const schemas: SchemasType = {};
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
        })
      );
    })
  );

  await fs.writeFile(schemasPath, JSON.stringify(schemas), {
    encoding: "utf-8",
  });
}

type WatchOptionsType = (
  | { output: string }
  | {
      onOutput: (
        graphId: string,
        result: { basename: string; contents: Uint8Array }[]
      ) => void;
    }
) &
  BuildEnvType;

export async function watch(options: WatchOptionsType) {
  const { cwd, config, defs } = getBuildEnv(options);

  if ("onOutput" in options) {
    await Promise.all(
      Object.entries(defs).map(async ([graphId, userPath]) => {
        await bundler.watch(graphId, { cwd, config, userPath }, (files) =>
          options.onOutput(graphId, files)
        );
      })
    );

    return;
  }

  const fullPath = path.resolve(cwd, options.output);
  const publicPath = path.resolve(fullPath, "public");
  const schemasPath = path.resolve(fullPath, "schemas.json");

  let promiseSeq = Promise.resolve();

  const schemas: SchemasType = {};
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
              })
            );

            await fs.writeFile(schemasPath, JSON.stringify(schemas), {
              encoding: "utf-8",
            });
          },
          (e) => console.error(e)
        );
      });
    })
  );
}
