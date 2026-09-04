#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;


main(["--mode", "rpc", ...process.argv.slice(2)]);
