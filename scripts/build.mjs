#!/usr/bin/env zx
await spinner("Removing `dist`", () => fs.remove("dist"));
await spinner("Building", () => $`tsc --outDir dist`);
await spinner("Moving files from `dist/src` to `dist`", async () => {
  const files = await glob("dist/src/**/*");
  await Promise.all(
    files.map((file) => fs.move(file, file.replace("src/", "")))
  );
});
await spinner("Copying `types.template.mts`", () =>
  fs.copy(
    "src/graph/parser/schema/types.template.mts",
    "dist/graph/parser/schema/types.template.mts"
  )
);
await spinner("Removing unnecessary files", async () =>
  Promise.all([
    fs.remove("dist/graph/parser/schema/types.template.mjs"),
    fs.remove("dist/src"),
    fs.remove("dist/tests"),
  ])
);
