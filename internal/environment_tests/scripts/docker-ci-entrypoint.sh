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

cp -r ../langgraph ./libs/
cp -r ../langgraph-core ./libs/
cp -r ../checkpoint ./libs/
cp -r ../sdk ./libs/

# Debug: show workspace structure
echo "=== Workspace packages ==="
ls -la libs/
for pkg in libs/*/; do
  if [ -f "$pkg/package.json" ]; then
    echo "$pkg: $(grep -o '"name": "[^"]*"' "$pkg/package.json" | head -1)"
  fi
done

# Remove workspace devDependencies that aren't available in this limited workspace
# This is needed because pnpm validates all workspace references even with --prod
for pkg in libs/*/; do
  if [ -f "$pkg/package.json" ]; then
    # Remove devDependencies that reference workspace packages not in our limited set
    sed -i 's/"@langchain\/langgraph-checkpoint-postgres": "workspace:\*",*//g' "$pkg/package.json"
    sed -i 's/"@langchain\/langgraph-checkpoint-sqlite": "workspace:\*",*//g' "$pkg/package.json"
  fi
done

# Install production dependencies only
pnpm install --prod

# Check the build command completes successfully
pnpm build

# Check the test command completes successfully
pnpm test
