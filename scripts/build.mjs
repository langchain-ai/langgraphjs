#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as process from "node:process";

if (process.platform === "win32") {
  spawn(
    "powershell.exe",
    ["-ExecutionPolicy", "Bypass", "-File", "scripts/build.ps1"],
    { stdio: "inherit" }
  );
} else {
  spawn("bash", ["-c", "scripts/build.sh"], { stdio: "inherit" });
}
