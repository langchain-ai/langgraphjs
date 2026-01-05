import fs from "node:fs/promises";
import path from "node:path";

import {
  intro,
  outro,
  spinner,
  confirm,
  isCancel,
  cancel,
} from "@clack/prompts";
import color from "picocolors";
import dedent from "dedent";

export interface AgentInfo {
  name: string;
  filePath: string;
  isExported: boolean;
  lineNumber: number;
}

interface LangGraphConfig {
  node_version?: string;
  graphs: Record<string, string>;
  env?: string;
}

// Pattern strings for detecting LangGraph agents (will create fresh RegExp for each file)
// Note: Using [a-zA-Z_$][\\w$]* to match valid JS identifiers (including $ prefix)
export const AGENT_PATTERN_STRINGS = [
  // ESM: createAgent
  "(?:export\\s+)?(?:const|let|var)\\s+([a-zA-Z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?createAgent\\s*\\(",
  // ESM: StateGraph().compile() or workflow.compile()
  "(?:export\\s+)?(?:const|let|var)\\s+([a-zA-Z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:new\\s+StateGraph\\s*\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\.compile\\s*\\(",
  // CJS: module.exports.name = createAgent(...) or exports.name = createAgent(...)
  "(?:module\\.)?exports\\.([a-zA-Z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?createAgent\\s*\\(",
  // CJS: module.exports.name = workflow.compile(...) or exports.name = workflow.compile(...)
  "(?:module\\.)?exports\\.([a-zA-Z_$][\\w$]*)\\s*=\\s*(?:await\\s+)?(?:new\\s+StateGraph\\s*\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\.compile\\s*\\(",
];

// Pattern to check if it's an ESM export
export const ESM_EXPORT_PATTERN = /^export\s+/;
// Pattern to check if it's a CJS export
export const CJS_EXPORT_PATTERN = /^(?:module\.)?exports\./;

/**
 * Scan content string for LangGraph agent definitions
 * Exported for testing purposes
 */
export function scanContentForAgents(
  content: string,
  filePath: string = "test.ts"
): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const lines = content.split("\n");

  for (const patternString of AGENT_PATTERN_STRINGS) {
    // Create a fresh RegExp for each pattern to avoid lastIndex issues
    const pattern = new RegExp(patternString, "g");

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      const matchIndex = match.index;

      // Find the line number
      let lineNumber = 1;
      let charCount = 0;
      for (const line of lines) {
        if (charCount + line.length >= matchIndex) {
          break;
        }
        charCount += line.length + 1; // +1 for newline
        lineNumber++;
      }

      // Check if it's exported (ESM or CJS)
      const isExported =
        ESM_EXPORT_PATTERN.test(match[0]) || CJS_EXPORT_PATTERN.test(match[0]);

      // Avoid duplicates
      if (!agents.find((a) => a.name === name && a.lineNumber === lineNumber)) {
        agents.push({
          name,
          filePath,
          isExported,
          lineNumber,
        });
      }
    }
  }

  return agents;
}

/**
 * Scan a file for LangGraph agent definitions
 */
async function scanFileForAgents(filePath: string): Promise<AgentInfo[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return scanContentForAgents(content, filePath);
  } catch (error) {
    // Skip files that can't be read
    return [];
  }
}

/**
 * Recursively find all TypeScript and JavaScript files in a directory
 */
async function findTsJsFiles(
  dir: string,
  files: string[] = []
): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip node_modules, dist, .git, etc.
    if (
      entry.isDirectory() &&
      !["node_modules", "dist", ".git", ".turbo", "build", "coverage"].includes(
        entry.name
      )
    ) {
      await findTsJsFiles(fullPath, files);
    } else if (
      entry.isFile() &&
      /\.(ts|tsx|mts|js|jsx|mjs)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Generate the langgraph.json configuration
 */
export async function generateConfig(targetPath?: string) {
  const targetRootPath = targetPath ? path.resolve(targetPath) : process.cwd();

  intro(`${color.bgCyan(color.black(" 🦜 create-langgraph config "))}`);

  // Check if langgraph.json already exists
  const configPath = path.join(targetRootPath, "langgraph.json");
  try {
    await fs.access(configPath);
    const overwrite = await confirm({
      message: `${color.yellow(
        "langgraph.json"
      )} already exists. Do you want to overwrite it?`,
      initialValue: false,
    });

    if (isCancel(overwrite) || !overwrite) {
      cancel("Operation cancelled");
      process.exit(0);
    }
  } catch {
    // File doesn't exist, continue
  }

  const s = spinner();
  s.start(`Scanning for LangGraph agents in ${targetRootPath}...`);

  // Find all TS/JS files
  let files: string[];
  try {
    files = await findTsJsFiles(targetRootPath);
  } catch (error) {
    s.stop("Error scanning directory");
    throw new Error(`Failed to scan directory: ${(error as Error).message}`);
  }

  if (files.length === 0) {
    s.stop("No TypeScript or JavaScript files found");
    outro(
      color.yellow(
        "No TypeScript or JavaScript files found in the current directory."
      )
    );
    return;
  }

  // Scan all files for agents
  const allAgents: AgentInfo[] = [];
  for (const file of files) {
    const agents = await scanFileForAgents(file);
    allAgents.push(...agents);
  }

  s.stop(`Found ${allAgents.length} agent(s) in ${files.length} file(s)`);

  if (allAgents.length === 0) {
    outro(
      color.yellow(
        dedent`
          No LangGraph agents found.
          
          Make sure your agents are defined using one of these patterns:
          - ${color.cyan("createAgent({ ... })")}
          - ${color.cyan("createReactAgent({ ... })")}
          - ${color.cyan("new StateGraph(...).compile()")}
          - ${color.cyan("workflow.compile()")}
        `
      )
    );
    return;
  }

  // Separate exported and unexported agents
  const exportedAgents = allAgents.filter((a) => a.isExported);
  const unexportedAgents = allAgents.filter((a) => !a.isExported);

  // Warn about unexported agents
  if (unexportedAgents.length > 0) {
    console.log();
    console.log(
      color.yellow(
        `⚠️  Found ${unexportedAgents.length} agent(s) that are not exported:`
      )
    );
    for (const agent of unexportedAgents) {
      const relativePath = path.relative(targetRootPath, agent.filePath);
      console.log(
        color.dim(
          `   • ${color.white(agent.name)} at ${relativePath}:${
            agent.lineNumber
          }`
        )
      );
    }
    console.log(
      color.dim(
        `   Add ${color.cyan(
          "export"
        )} keyword to include them in the configuration.`
      )
    );
    console.log();
  }

  if (exportedAgents.length === 0) {
    outro(
      color.yellow(
        dedent`
          No exported agents found.
          
          To include an agent in the configuration, make sure it's exported:
          ${color.cyan("export const agent = createAgent({ ... });")}
        `
      )
    );
    return;
  }

  // Build the graphs config
  const graphs: Record<string, string> = {};
  const usedKeys = new Set<string>();

  for (const agent of exportedAgents) {
    const relativePath = path.relative(targetRootPath, agent.filePath);
    // Use ./ prefix for relative paths
    const normalizedPath = relativePath.startsWith(".")
      ? relativePath
      : `./${relativePath}`;

    // Generate a unique key for the graph
    let key = agent.name;

    // If the key is already used, derive from the directory or file name
    if (usedKeys.has(key)) {
      // Try to use the parent directory name
      const dirName = path.basename(path.dirname(agent.filePath));
      if (dirName && dirName !== "." && !usedKeys.has(dirName)) {
        key = dirName;
      } else {
        // Use filename without extension as fallback
        const fileName = path
          .basename(agent.filePath)
          .replace(/\.(ts|tsx|mts|js|jsx|mjs)$/, "");
        key = `${fileName}-${agent.name}`;

        // If still a collision, add a numeric suffix
        let suffix = 1;
        let uniqueKey = key;
        while (usedKeys.has(uniqueKey)) {
          uniqueKey = `${key}-${suffix}`;
          suffix++;
        }
        key = uniqueKey;
      }
    }

    usedKeys.add(key);
    graphs[key] = `${normalizedPath}:${agent.name}`;
  }

  // Detect Node.js version
  const nodeVersion = process.version.replace(/^v/, "").split(".")[0];

  // Check if .env file exists
  let envPath: string | undefined;
  try {
    await fs.access(path.join(targetRootPath, ".env"));
    envPath = ".env";
  } catch {
    // .env doesn't exist
  }

  // Create the config
  const config: LangGraphConfig = {
    node_version: nodeVersion,
    graphs,
  };

  if (envPath) {
    config.env = envPath;
  }

  // Write the config file
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");

  // Summary
  console.log();
  console.log(color.green("✓ Created langgraph.json with:"));
  for (const [name, graphPath] of Object.entries(graphs)) {
    console.log(color.dim(`   • ${color.white(name)}: ${graphPath}`));
  }
  console.log();

  outro(
    dedent`
      ${color.green("Configuration created successfully!")}
      
      ${color.cyan("Next steps:")}
      - Review the generated ${color.yellow("langgraph.json")}
      - Run ${color.cyan(
        "npx @langchain/langgraph-cli@latest dev"
      )} to start the development server
    `
  );
}
