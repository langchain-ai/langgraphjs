import { builder } from "./utils/builder.mjs";
import { detect } from "package-manager-detector";
import { $ } from "execa";

builder
  .command("sysinfo")
  .description("Print system information")
  .action(async () => {
    const manager = await detect();
    if (!manager) throw new Error("No package manager detected");

    console.log("Node version:", process.version);
    console.log("Operating system:", process.platform, process.arch);
    console.log("Package manager:", manager.name);
    console.log("Package manager version:", manager.version);

    console.log("-".repeat(20));

    const output = await (async () => {
      switch (manager.name) {
        case "npm":
          return await $`npm ls --depth=4`;

        case "yarn":
          if (manager.version === "berry") {
            return await $`yarn info`;
          }

          return await $`yarn list --depth=4`;

        case "pnpm":
          return await $`pnpm ls --depth=4`;

        case "bun":
          return await $`bun pm ls`;

        default:
          return await $`npm ls`;
      }
    })();
    const gatherMatch = (str: string, regex: RegExp) => {
      return [...new Set(str.matchAll(regex).map((match) => match[0]))];
    };

    const packages = gatherMatch(
      output.stdout,
      /(@langchain\/[^\s@]+|langsmith|langchain|zod|zod-to-json-schema)/g
    );

    async function getPackageInfo(packageName: string) {
      switch (manager?.name) {
        case "npm":
          return (await $`npm explain ${packageName}`).stdout;

        case "yarn":
          return (await $`yarn why ${packageName}`).stdout;

        case "pnpm":
          return (await $`pnpm why ${packageName}`).stdout;

        case "bun":
          return (await $`bun why ${packageName}`).stdout;

        default:
          return null;
      }
    }

    function escapeRegExp(text: string) {
      return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
    }

    for (const pkg of packages) {
      const info = await getPackageInfo(pkg);
      if (!info) continue;

      const targetRegex = new RegExp(escapeRegExp(pkg) + "[@\\s][^\\s]*", "g");
      console.log(
        pkg,
        "->",
        gatherMatch(info, targetRegex)
          .map((i) => i.slice(pkg.length).trim())
          .join(", ")
      );
    }
  });
