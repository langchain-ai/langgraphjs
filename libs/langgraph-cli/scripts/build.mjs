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

await $`yarn tsc --outDir dist`;
await $`mv dist/src/* dist`;
await $`rm -rf dist/src dist/tests`;
