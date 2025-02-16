import * as path from "node:path";
import * as url from "node:url";
import * as fs from "node:fs";

import { z } from "zod";
import { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import { zValidator } from "@hono/zod-validator";
import { context } from "esbuild";
import tailwind from "esbuild-plugin-tailwindcss";

const GRAPH_UI: Record<string, { basename: string; contents: Uint8Array }[]> =
  {};

export async function registerGraphUi(
  defs: Record<string, string>,
  options: { cwd: string },
) {
  const textEncoder = new TextEncoder();
  const renderTemplate = await fs.promises.readFile(
    path.resolve(
      path.dirname(url.fileURLToPath(import.meta.url)),
      "./render.mts",
    ),
    "utf-8",
  );

  const projectDir = options.cwd;
  const result = await Promise.all(
    Object.entries(defs).map(async ([agentName, uiUserPath]) => {
      const ctx = await context({
        entryPoints: ["entrypoint"],
        outdir: path.resolve(projectDir, "dist"),
        bundle: true,
        platform: "browser",
        target: "es2020",
        external: ["react", "react-dom", "@langchain/langgraph-sdk"],
        plugins: [
          {
            name: "entrypoint",
            setup(build) {
              build.onResolve({ filter: /^entrypoint$/ }, (args) => ({
                path: path.resolve(projectDir, "ui.entrypoint.tsx"),
                namespace: "entrypoint-ns",
              }));

              build.onLoad(
                { filter: /.*/, namespace: "entrypoint-ns" },
                () => ({
                  resolveDir: projectDir,
                  contents: [
                    `import ui from "${uiUserPath}"`,
                    renderTemplate,
                    `export const render = createRenderer(ui)`,
                  ].join("\n"),
                  loader: "tsx",
                }),
              );
            },
          },
          tailwind(),
          {
            name: "require-transform",
            setup(build) {
              build.onEnd(async (result) => {
                const newResult: {
                  basename: string;
                  contents: Uint8Array;
                }[] = [];

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

                if (newResult.length > 0) {
                  GRAPH_UI[agentName] = newResult;
                }
              });
            },
          },
        ],
        write: false,
        globalName: `__LGUI_${agentName}`,
      });

      await ctx.watch();
      return [agentName, ctx] as [string, typeof ctx];
    }),
  );

  return Object.fromEntries(result);
}

const api = new Hono();

api.post(
  "/ui/:agent",
  zValidator("json", z.object({ shadowRootId: z.string() })),
  async (c) => {
    const agent = c.req.param("agent");
    const host = c.req.header("host");
    const body = await c.req.valid("json");

    const files = GRAPH_UI[agent];
    if (!files?.length) return c.text(`UI not found for agent "${agent}"`, 404);

    const strAgent = JSON.stringify(agent);
    const strRootId = JSON.stringify(body.shadowRootId);

    const result = [
      `<script src="http://${host}/${agent}/entrypoint.js" onload='__LGUI_${agent}.render(${strAgent}, ${strRootId})'></script>`,
    ];

    for (const css of files.filter(
      (i) => path.extname(i.basename) === ".css",
    )) {
      result.push(
        `<link rel="stylesheet" href="http://${host}/ui/${agent}/${css.basename}" />`,
      );
    }

    const js = files.find((i) => path.extname(i.basename) === ".js");
    if (js) {
      result.push(`<script src="http://${host}/ui/${agent}/${js.basename}" />`);
    }

    return c.text(result.join("\n"), {
      headers: { "Content-Type": "text/html" },
    });
  },
);

api.get("/ui/:agent/:basename", async (c) => {
  const agent = c.req.param("agent");
  const basename = c.req.param("basename");
  const file = GRAPH_UI[agent]?.find((item) => item.basename === basename);
  if (!file) return c.text("File not found", 404);

  // @ts-expect-error TODO weird TS error?
  return c.body(file.contents, {
    headers: { "Content-Type": getMimeType(file.basename) ?? "text/plain" },
  });
});

export default api;
