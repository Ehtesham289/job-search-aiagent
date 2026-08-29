#!/usr/bin/env node
import { env } from "../config/env.js";
import { SqliteStore } from "./sqlite.js";
import { seedMemory } from "../tools/skills.js";

/**
 * Applies the schema and seeds long-term memory. Safe to run repeatedly —
 * every statement is CREATE IF NOT EXISTS and every seed is an upsert.
 */
const store = new SqliteStore(env.dbPath);
seedMemory(store);
const sources = store.listSources({ limit: 10_000 });
console.log(`schema applied at ${env.dbPath}`);
console.log(`  ${sources.filter((s) => s.status === "verified").length} verified sources`);
console.log(`  ${store.listRuns(10_000).length} runs`);
store.close();
