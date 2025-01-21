#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as process from "node:process";

const file = process.argv.at(-1);

const proc =
  process.platform === "win32"
    ? spawn(
        "powershell.exe",
        ["-ExecutionPolicy", "Bypass", "-File", `scripts/${file}.ps1`],
        { stdio: "inherit" }
      )
    : spawn("bash", ["-c", `scripts/${file}.sh`], { stdio: "inherit" });

proc.on("exit", (code) => process.exit(code ?? 0));
