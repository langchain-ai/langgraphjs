import * as path from "node:path";
import * as url from "node:url";
import * as fs from "node:fs";

import {
  build as runBuild,
  context as runContext,
  type BuildOptions,
  type Plugin,
} from "esbuild";

import tailwind from "esbuild-plugin-tailwindcss";

const renderTemplate = await fs.promises.readFile(
  url.fileURLToPath(new URL("./render.template.mts", import.meta.url)),
  "utf-8",
);

function entrypointPlugin(uiUserPath: string): Plugin {
  const projectDir = path.dirname(uiUserPath);
  return {
    name: "entrypoint",
    setup(build) {
      build.onResolve({ filter: /^entrypoint$/ }, (args) => ({
        path: path.resolve(projectDir, "ui.entrypoint.tsx"),
        namespace: "entrypoint-ns",
      }));

      build.onLoad({ filter: /.*/, namespace: "entrypoint-ns" }, () => ({
        resolveDir: projectDir,
        contents: [
          `import ui from "${uiUserPath}"`,
          renderTemplate,
          `export const render = createRenderer(ui)`,
        ].join("\n"),
        loader: "tsx",
      }));
    },
  };
}

function registerPlugin(
  onEnd: (result: { basename: string; contents: Uint8Array }[]) => void,
): Plugin {
  const textEncoder = new TextEncoder();
  return {
    name: "require-transform",
    setup(build) {
      build.onEnd(async (result) => {
        const newResult: { basename: string; contents: Uint8Array }[] = [];
        for (const item of result.outputFiles ?? []) {
          let basename = path.basename(item.path);
          let contents = item.contents;
          if (basename === "entrypoint.js") {
            contents = textEncoder.encode(
              item.text.replaceAll(
                `typeof require !== "undefined" ? require`,
                `typeof globalThis[Symbol.for("LGUI_REQUIRE")] !== "undefined" ? globalThis[Symbol.for("LGUI_REQUIRE")]`,
              ),
            );
          }

          newResult.push({ basename, contents });
        }
        if (newResult.length > 0) onEnd(newResult);
      });
    },
  };
}

function setup(
  agentName: string,
  uiUserPath: string,
  onResult: (result: { basename: string; contents: Uint8Array }[]) => void,
): BuildOptions {
  return {
    write: false,
    outdir: path.resolve(path.dirname(uiUserPath), "dist"),
    entryPoints: ["entrypoint"],
    bundle: true,
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    external: [
      "react",
      "react-dom",
      "@langchain/langgraph-sdk",
      "@langchain/langgraph-sdk/react-ui",
    ],
    plugins: [
      tailwind(),
      entrypointPlugin(uiUserPath),
      registerPlugin(onResult),
    ],
    globalName: `__LGUI_${agentName}`,
  };
}

export async function build(agentName: string, uiUserPath: string) {
  let results: { basename: string; contents: Uint8Array }[] = [];
  await runBuild(setup(agentName, uiUserPath, (result) => (results = result)));
  return results;
}

export async function watch(
  agentName: string,
  uiUserPath: string,
  onResult: (result: { basename: string; contents: Uint8Array }[]) => void,
) {
  const ctx = await runContext(setup(agentName, uiUserPath, onResult));
  await ctx.watch();
  return ctx;
}
