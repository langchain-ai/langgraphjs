#!/usr/bin/env node
import { register } from "node:module";
import { main } from "../dist/cli.js";

register("@swc-node/register/esm", import.meta.url);

await main();
