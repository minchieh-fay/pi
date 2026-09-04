#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { consumeInternalProcessRole, INTERNAL_PROCESS_ENV } from "./experimental/process.ts";
import { runServerProcess } from "./experimental/server.ts";
import { runSessionWorkerProcess } from "./experimental/session-worker.ts";
import { main } from "./main.ts";

//const internalProcessRole = consumeInternalProcessRole();
//delete process.env[INTERNAL_PROCESS_ENV];"__PI_INTERNAL_SPAWN"
// process.title = APP_NAME;
// process.env.PI_CODING_AGENT = "true";
// process.env.AI_AGENT = "pi";
// process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// Runtime settings are applied once SettingsManager has loaded global/project settings.

main(process.argv.slice(2));

