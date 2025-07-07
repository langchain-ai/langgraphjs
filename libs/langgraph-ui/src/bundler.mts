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
  "utf-8"
);

function entrypointPlugin(paths: { cwd: string; userPath: string }): Plugin {
  const fullPath = path.resolve(paths.cwd, paths.userPath);

  let relativeUiPath = path
    .relative(paths.cwd, fullPath)
    .replaceAll(path.sep, "/");

  if (relativeUiPath.startsWith("../")) {
    throw new Error(
      `UI path must be relative to the project root. Received: "${relativeUiPath}"`
    );
  }

  if (!relativeUiPath.startsWith("./")) relativeUiPath = `./${relativeUiPath}`;

  return {
    name: "entrypoint",
    setup(build) {
      build.onResolve({ filter: /^entrypoint$/ }, () => ({
        path: path.resolve(path.dirname(fullPath), "ui.entrypoint.tsx"),
        namespace: "entrypoint-ns",
      }));

      build.onLoad({ filter: /.*/, namespace: "entrypoint-ns" }, () => ({
        resolveDir: paths.cwd,
        contents: [
          `import ui from "${relativeUiPath}"`,
          renderTemplate,
          `export const render = createRenderer(ui)`,
        ].join("\n"),
        loader: "tsx",
      }));
    },
  };
}

function registerPlugin(
  onEnd: (result: { basename: string; contents: Uint8Array }[]) => void
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
                `typeof globalThis[Symbol.for("LGUI_REQUIRE")] !== "undefined" ? globalThis[Symbol.for("LGUI_REQUIRE")]`
              )
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
  args: { cwd: string; userPath: string; config?: { shared?: string[] } },
  onResult: (result: { basename: string; contents: Uint8Array }[]) => void
): BuildOptions {
  return {
    write: false,
    outdir: path.resolve(args.cwd, "dist"),
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
      ...(args.config?.shared ?? []),
    ],
    plugins: [tailwind(), entrypointPlugin(args), registerPlugin(onResult)],
    globalName: `__LGUI_${agentName.replace(/[^a-zA-Z0-9]/g, "_")}`,
  };
}

export async function build(
  agentName: string,
  args: { cwd: string; userPath: string; config?: { shared?: string[] } }
) {
  let results: { basename: string; contents: Uint8Array }[] = [];
  await runBuild(setup(agentName, args, (result) => (results = result)));
  return results;
}

export async function watch(
  agentName: string,
  args: { cwd: string; userPath: string; config?: { shared?: string[] } },
  onResult: (result: { basename: string; contents: Uint8Array }[]) => void
) {
  const ctx = await runContext(setup(agentName, args, onResult));
  await ctx.watch();
  return ctx;
}
