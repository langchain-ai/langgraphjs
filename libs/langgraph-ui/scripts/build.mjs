import { exec } from "node:child_process";

function $(strings) {
  const command = strings.join(" ");
  console.log(command);

  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) return reject(error);
      return resolve({ stdout, stderr });
    });
  });
}

await $`pnpm tsc --outDir dist`;
await $`cp src/render.template.mts dist`;
await $`rm -rf dist/render.template.mjs dist/render.template.d.mts dist/cli.d.mts`;
