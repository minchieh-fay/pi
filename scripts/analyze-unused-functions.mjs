#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import process from "node:process";

const root = new URL("../packages/coding-agent/src/", import.meta.url);
const sourceFiles = await collectTypeScriptFiles(root);
const sources = new Map();

for (const file of sourceFiles) {
	const source = await readFile(file, "utf8");
	sources.set(file, source);
}

const candidates = [];
for (const [file, source] of sources) {
	for (const match of source.matchAll(/^(\s*)(?:(?:export\s+)?(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/gm)) {
		const name = match[2];
		const declaration = match[0];

		// Exported functions are public API or extension entry points. Keep them
		// out of this intentionally conservative first pass.
		if (/\bexport\b/.test(declaration)) continue;

		const references = source.replace(match[0], "").match(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g")) ?? [];
		if (references.length === 0) {
			const line = source.slice(0, match.index).split("\n").length;
			candidates.push(`${relative(process.cwd(), file.pathname)}:${line} ${name}`);
		}
	}
}

if (candidates.length === 0) {
	console.log("No private function candidates found.");
} else {
	console.log("Private functions with no textual reference in their own file:");
	console.log(candidates.join("\n"));
	console.log("\nReview each result before deleting it; dynamic imports and cross-file calls are not inferred.");
}

async function collectTypeScriptFiles(directory) {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];

	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
		if (entry.isDirectory()) files.push(...(await collectTypeScriptFiles(path)));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
	}

	return files;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
