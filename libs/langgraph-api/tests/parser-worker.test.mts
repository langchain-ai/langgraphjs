import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { expect, test } from "vitest";

test.each([
  {
    name: "worker error does not keep the process alive until the timeout",
    worker: 'throw new Error("schema extraction failed");',
    timeoutMs: 120_000,
    expected: "schema extraction failed",
  },
  {
    name: "successful extraction clears the timeout",
    worker: `
      import { parentPort } from "node:worker_threads";
      parentPort.once("message", () => parentPort.postMessage([{}]));
    `,
    timeoutMs: 120_000,
    expected: "{}",
  },
  {
    name: "a stuck worker still times out and terminates",
    worker: `
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => {});
    `,
    timeoutMs: 100,
    expected: "Schema extract worker timed out",
  },
])("$name", async ({ worker, timeoutMs, expected }) => {
  const dir = await mkdtemp(join(tmpdir(), "langgraph-schema-worker-"));
  try {
    const source = await readFile(
      new URL("../src/graph/parser/index.mts", import.meta.url),
      "utf8",
    );
    const { outputText } = transpileModule(source, {
      compilerOptions: {
        module: ModuleKind.ESNext,
        target: ScriptTarget.ES2022,
      },
    });
    await writeFile(join(dir, "index.mjs"), outputText);
    await writeFile(join(dir, "parser.worker.mjs"), worker);
    await writeFile(
      join(dir, "run.mjs"),
      `
        import { getStaticGraphSchema } from "./index.mjs";
        try {
          const schema = await getStaticGraphSchema(
            { sourceFile: "graph.mts", exportSymbol: "graph" },
            { timeoutMs: ${timeoutMs} },
          );
          console.log(JSON.stringify(schema));
        } catch (error) {
          console.log(error.message);
        }
      `,
    );

    // The caller catches schema errors; a leaked timer must not delay its exit.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [join(dir, "run.mjs")],
      { timeout: 5_000, maxBuffer: 64 * 1024, env: {} },
    );
    expect(stdout.trim()).toBe(expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
