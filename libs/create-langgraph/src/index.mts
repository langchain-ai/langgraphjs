import {
  intro,
  outro,
  select,
  text,
  isCancel,
  cancel,
  confirm,
} from "@clack/prompts";
import * as fs from "fs/promises";
import * as path from "path";
import zipExtract from "extract-zip";
import color from "picocolors";
import dedent from "dedent";
import { spawn } from "child_process";

const TEMPLATES = {
  "New LangGraph Project": {
    description: "A simple, minimal chatbot with memory.",
    python:
      "https://github.com/langchain-ai/new-langgraph-project/archive/refs/heads/main.zip",
    js: "https://github.com/langchain-ai/new-langgraphjs-project/archive/refs/heads/main.zip",
  },
  "ReAct Agent": {
    description: "A simple agent that can be flexibly extended to many tools.",
    python:
      "https://github.com/langchain-ai/react-agent/archive/refs/heads/main.zip",
    js: "https://github.com/langchain-ai/react-agent-js/archive/refs/heads/main.zip",
  },
  "Memory Agent": {
    description:
      "A ReAct-style agent with an additional tool to store memories for use across conversational threads.",
    python:
      "https://github.com/langchain-ai/memory-agent/archive/refs/heads/main.zip",
    js: "https://github.com/langchain-ai/memory-agent-js/archive/refs/heads/main.zip",
  },
  "Retrieval Agent": {
    description:
      "An agent that includes a retrieval-based question-answering system.",
    python:
      "https://github.com/langchain-ai/retrieval-agent-template/archive/refs/heads/main.zip",
    js: "https://github.com/langchain-ai/retrieval-agent-template-js/archive/refs/heads/main.zip",
  },
  "Data-enrichment Agent": {
    description:
      "An agent that performs web searches and organizes its findings into a structured format.",
    python:
      "https://github.com/langchain-ai/data-enrichment/archive/refs/heads/main.zip",
    js: "https://github.com/langchain-ai/data-enrichment-js/archive/refs/heads/main.zip",
  },
};

const getPmSpecificCommands = (): { install: string; exec: string } => {
  const npmExecPath = process.env.npm_execpath as string | undefined;

  // default to yarn, as most examples include yarn.lock
  if (!npmExecPath) return { install: "yarn install", exec: "npx" };

  const npmBin = path
    .basename(npmExecPath)
    .substring(0, -path.extname(npmExecPath).length);

  if (npmBin === "yarn") return { install: "yarn install", exec: "npx" };
  if (npmBin === "pnpm") return { install: "pnpm install", exec: "pnpm dlx" };
  if (npmBin === "bun") return { install: "bun install", exec: "bunx" };
  return { install: "npm install", exec: "npx" };
};

// Generate template IDs programmatically
const TEMPLATE_ID_TO_CONFIG = Object.entries(TEMPLATES).reduce(
  (acc, [name, versions]) => {
    Object.entries(versions)
      .filter(([lang]) => lang === "python" || lang === "js")
      .forEach(([lang, url]) => {
        const id = `${name.toLowerCase().replace(/ /g, "-")}-${lang}`;
        acc[id] = [name, lang, url];
      });
    return acc;
  },
  {} as Record<string, [string, string, string]>
);

const TEMPLATE_IDS = Object.keys(TEMPLATE_ID_TO_CONFIG);

async function downloadAndExtract(url: string, targetPath: string) {
  try {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to download: ${response.statusText}`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    await fs.mkdir(targetPath, { recursive: true });

    // Create a temporary file to store the zip
    const tempFile = path.join(targetPath, "temp.zip");
    await fs.writeFile(tempFile, buffer);

    // Extract the zip file
    await zipExtract(tempFile, { dir: targetPath });

    // Clean up temp file
    await fs.unlink(tempFile);

    // Move files from the extracted directory to target path
    const extractedDir = (await fs.readdir(targetPath)).find((f) =>
      f.endsWith("-main")
    );
    if (extractedDir) {
      const fullExtractedPath = path.join(targetPath, extractedDir);
      const files = await fs.readdir(fullExtractedPath);
      await Promise.all(
        files.map((file) =>
          fs.rename(
            path.join(fullExtractedPath, file),
            path.join(targetPath, file)
          )
        )
      );
      await fs.rmdir(fullExtractedPath);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to download and extract template: ${error.message}`
      );
    }
    throw new Error("Failed to download and extract template");
  }
}

export async function createNew(projectPath?: string, templateId?: string) {
  if (templateId) {
    const config = TEMPLATE_ID_TO_CONFIG[templateId];
    if (!config) {
      console.error(`Invalid template ID "${templateId}"`);
      console.error(
        `Available options:\n${TEMPLATE_IDS.map((id) => `- ${id}`).join("\n")}`
      );
      process.exit(1);
    }
  }

  intro(`${color.bgCyan(color.black(" 🦜 create-langgraph "))}`);

  let resolvedPath = projectPath;
  if (!resolvedPath) {
    const result = await text({
      message: "Where would you like to create your project?",
      placeholder: ".",
      defaultValue: ".",
    });

    if (isCancel(result)) {
      cancel("Operation cancelled");
      process.exit(0);
    }

    resolvedPath = result;
  }

  const absolutePath = path.resolve(resolvedPath);

  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const files = await fs.readdir(absolutePath);
      if (files.length > 0) throw new Error("Directory is not empty");
    }
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  let language: "js" | "python" = "js";
  let templateUrl: string;
  if (templateId) {
    const config = TEMPLATE_ID_TO_CONFIG[templateId];
    if (!config) throw new Error("Invalid template ID.");
    templateUrl = config[2];
  } else {
    const templateChoice = await select({
      message: "Select a template",
      options: Object.entries(TEMPLATES).map(([name, info]) => ({
        value: name,
        label: name,
        hint: info.description,
      })),
    });

    if (isCancel(templateChoice)) {
      cancel("Operation cancelled");
      process.exit(0);
    }

    const template = TEMPLATES[templateChoice as keyof typeof TEMPLATES];
    if (!template) throw new Error("Invalid template choice");
    templateUrl = template[language];
  }

  await downloadAndExtract(templateUrl, absolutePath);

  // delete yarn.lock
  try {
    await fs.unlink(path.join(absolutePath, "yarn.lock"));
  } catch {
    // do nothing
  }

  const shouldInitGit = await confirm({
    message: "Would you like to run `git init`?",
    initialValue: true,
    active: "Yes",
    inactive: "No",
  });

  if (shouldInitGit) {
    await new Promise((resolve, reject) => {
      const proc = spawn("git", ["init"], { cwd: absolutePath });
      proc.on("close", (code) => {
        if (code === 0) resolve(undefined);
        else reject(new Error(`git init failed with code ${code}`));
      });
    });
  }

  const pm = getPmSpecificCommands();

  const guide =
    language === "js"
      ? color.cyan(
          dedent`
            Next steps:
            - cd ${path.relative(process.cwd(), absolutePath)}
            - ${pm.install}
            - ${pm.exec} @langchain/langgraph-cli@latest dev
          `
        )
      : null;

  outro(
    [`Project created successfully at ${color.green(absolutePath)}`, guide]
      .filter(Boolean)
      .join("\n\n")
  );
}
