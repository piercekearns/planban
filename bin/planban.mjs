#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDependencies, loadRuntimeTypescript } from "../plugins/planban/scripts/runtime-dependencies.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await ensureRuntimeDependencies(runtimeRoot);
await loadRuntimeTypescript(runtimeRoot);
await import("../src/cli.ts");
