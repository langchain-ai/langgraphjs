/**
 * Post-build step: rename `.svelte.js` / `.svelte.cjs` output files
 * to plain `.js` / `.cjs` so that downstream Svelte Vite plugins
 * do not attempt to re-compile the already-compiled output.
 */
import { readdirSync, renameSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const dist = "dist";
const SVELTE_EXT = /\.svelte\.(js|cjs|mjs)/g;

for (const file of readdirSync(dist)) {
  if (!file.includes(".svelte.")) continue;
  const newName = file.replace(/\.svelte\./g, ".");
  renameSync(join(dist, file), join(dist, newName));
}

for (const file of readdirSync(dist)) {
  if (!file.endsWith(".js") && !file.endsWith(".cjs")) continue;
  const filePath = join(dist, file);
  const content = readFileSync(filePath, "utf8");
  const fixed = content.replace(SVELTE_EXT, ".$1");
  if (fixed !== content) {
    writeFileSync(filePath, fixed);
  }
}
