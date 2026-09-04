#!/usr/bin/env bash

set -euxo pipefail

export CI=true

# TypeScript in these export tests can use a lot of memory in CI; raise the heap limit
# to avoid sporadic OOM failures on GitHub runners.
export NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}"

# Enable corepack to use pnpm
corepack enable
corepack prepare pnpm@10.27.0 --activate

# Copy all package files except node_modules and build artifacts
# Use rsync-like approach with find and cp
cd ../package
for item in *; do
  case "$item" in
    node_modules|dist|dist-cjs|dist-esm|build|.next|.turbo)
      # Skip these directories
      ;;
    *)
      cp -r "$item" /app/
      ;;
  esac
done
# Copy hidden files
for item in .[!.]*; do
  if [ -e "$item" ]; then
    cp -r "$item" /app/
  fi
done
cd /app

# Copy workspace packages
mkdir -p ./libs/langgraph/
mkdir -p ./libs/langgraph-core/
mkdir -p ./libs/checkpoint/
mkdir -p ./libs/sdk/
mkdir -p ./libs/sdk-react/
mkdir -p ./libs/sdk-vue/
mkdir -p ./libs/sdk-svelte/
mkdir -p ./libs/sdk-angular/

cp -r ../langgraph ./libs/
cp -r ../langgraph-core ./libs/
cp -r ../checkpoint ./libs/
cp -r ../sdk ./libs/
cp -r ../sdk-react ./libs/
cp -r ../sdk-vue ./libs/
cp -r ../sdk-svelte ./libs/
cp -r ../sdk-angular ./libs/

# Debug: show workspace structure
echo "=== Workspace packages ==="
ls -la libs/
for pkg in libs/*/; do
  if [ -f "$pkg/package.json" ]; then
    echo "$pkg: $(grep -o '"name": "[^"]*"' "$pkg/package.json" | head -1)"
  fi
done

# Remove workspace / registry deps that aren't available or needed in this
# limited export-test workspace. pnpm still resolves them from package.json
# even with --prod, and registry packages like `deepagents` depend on
# `@langchain/langgraph-sdk` at a version range that can point at an
# unpublished workspace bump (e.g. 1.10.1) and fail the install.
node <<'EOF'
const fs = require("fs");
const path = require("path");

const DROP_DEPS = new Set([
  "@langchain/langgraph-checkpoint-postgres",
  "@langchain/langgraph-checkpoint-sqlite",
  "@langchain/langgraph-api",
  "@langchain/build",
  // Test-only registry packages that pull @langchain/langgraph-sdk from npm.
  "deepagents",
  "langchain",
]);

for (const entry of fs.readdirSync("libs", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgPath = path.join("libs", entry.name, "package.json");
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let changed = false;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const section = pkg[field];
    if (section == null || typeof section !== "object") continue;
    for (const name of DROP_DEPS) {
      if (Object.prototype.hasOwnProperty.call(section, name)) {
        delete section[name];
        changed = true;
      }
    }
  }
  if (changed) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}
EOF

# Match the test app's direct @langchain/core dependency to the local LangGraph peer.
# This lets the environment tests follow dev builds that are not covered by ^1.x.
node <<'EOF'
const fs = require("fs");

const langgraphPackageJson = JSON.parse(
  fs.readFileSync("libs/langgraph-core/package.json", "utf8")
);
const coreVersion =
  langgraphPackageJson.peerDependencies?.["@langchain/core"] ??
  langgraphPackageJson.devDependencies?.["@langchain/core"];

if (!coreVersion) {
  throw new Error(
    "Could not find @langchain/core version in libs/langgraph-core/package.json"
  );
}

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
packageJson.dependencies ??= {};
packageJson.dependencies["@langchain/core"] = coreVersion;

fs.writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
console.log(`Pinned @langchain/core to ${coreVersion}`);
EOF

# Install production dependencies only
pnpm install --prod

# Check the build command completes successfully
pnpm build

# Check the test command completes successfully
pnpm test
