import { z } from "zod";
import { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";
import { zValidator } from "@hono/zod-validator";
import { watch } from "@langchain/langgraph-ui";
import * as path from "node:path";

const GRAPH_UI: Record<string, { basename: string; contents: Uint8Array }[]> =
  {};

export async function registerGraphUi(
  defs: Record<string, string>,
  options: { cwd: string; config?: { shared?: string[] } },
) {
  await watch({
    defs,
    cwd: options.cwd,
    config: options.config,
    onOutput: (graphId, files) => (GRAPH_UI[graphId] = files),
  });
}

export const api = new Hono();

api.post(
  "/ui/:agent",
  zValidator("json", z.object({ name: z.string() })),
  async (c) => {
    const agent = c.req.param("agent");
    const host = c.req.header("host");
    const message = await c.req.valid("json");

    const files = GRAPH_UI[agent];
    if (!files?.length) return c.text(`UI not found for agent "${agent}"`, 404);

    const messageName = JSON.stringify(message.name);
    const result = [];

    for (const css of files.filter(
      (i) => path.extname(i.basename) === ".css",
    )) {
      result.push(
        `<link rel="stylesheet" href="http://${host}/ui/${agent}/${css.basename}" />`,
      );
    }

    const js = files.find((i) => path.extname(i.basename) === ".js");
    if (js) {
      result.push(
        `<script src="http://${host}/ui/${agent}/${js.basename}" onload='__LGUI_${agent}.render(${messageName}, "{{shadowRootId}}")'></script>`,
      );
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

  return c.body(file.contents as unknown as ArrayBuffer, {
    headers: { "Content-Type": getMimeType(file.basename) ?? "text/plain" },
  });
});
