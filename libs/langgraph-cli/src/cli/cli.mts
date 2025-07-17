#!/usr/bin/env node
import { builder } from "./utils/builder.mjs";
import { flushAnalytics } from "./utils/analytics.mjs";
import { asyncExitHook, gracefulExit } from "exit-hook";

import "./dev.mjs";
import "./docker.mjs";
import "./build.mjs";
import "./up.mjs";
import "./sysinfo.mjs";

builder.exitOverride((error) => gracefulExit(error.exitCode));
asyncExitHook(() => flushAnalytics(), { wait: 2000 });

builder.parse();
