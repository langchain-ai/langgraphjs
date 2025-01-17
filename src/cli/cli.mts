#!/usr/bin/env node
import { builder } from "./utils/builder.mjs";

import "./dev.mjs";
import "./docker.mjs";
import "./build.mjs";
// import "./up.mjs";

builder.parse();
