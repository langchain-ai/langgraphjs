/**
 * Guard against #2481: uuid@12+ is ESM-only, so CJS artifacts must not call
 * require("uuid") at runtime. Jest does not transform node_modules and fails
 * on uuid's ESM entry with "Unexpected token 'export'".
 */
const fs = require("node:fs");
const path = require("node:path");

const WORKSPACE_LIBS_DIR = path.join(__dirname, "..", "libs");
const BARE_UUID_REQUIRE = /require\(["']uuid["']\)/;

function collectCjsFiles(dir, files = []) {
  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCjsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".cjs")) {
      files.push(fullPath);
    }
  }

  return files;
}

function main() {
  if (!fs.existsSync(WORKSPACE_LIBS_DIR)) {
    console.error(`workspace libs not found at ${WORKSPACE_LIBS_DIR}`);
    process.exit(1);
  }

  const offenders = [];

  for (const pkgDir of fs.readdirSync(WORKSPACE_LIBS_DIR)) {
    const distDir = path.join(WORKSPACE_LIBS_DIR, pkgDir, "dist");
    for (const file of collectCjsFiles(distDir)) {
      const source = fs.readFileSync(file, "utf8");
      if (BARE_UUID_REQUIRE.test(source)) {
        offenders.push(path.relative(WORKSPACE_LIBS_DIR, file));
      }
    }
  }

  if (offenders.length > 0) {
    console.error(
      "CJS build regression: bare require(\"uuid\") found in workspace dist:\n" +
        offenders.map((file) => `  - libs/${file}`).join("\n")
    );
    process.exit(1);
  }

  console.log("success");
}

main();
