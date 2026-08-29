import fs from "node:fs";
import path from "node:path";

/**
 * Minimal `.env` loader.
 *
 * Node's own `--env-file` throws when the file is absent (the
 * `--env-file-if-exists` form only landed in Node 22), and a credential that
 * has to be re-exported every shell session is a credential people paste into
 * their history. Fifteen lines is cheaper than either.
 *
 * A real environment variable always wins: this only fills in what is unset.
 */
export function loadDotEnv(file = path.resolve(".env")): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // No .env is the normal case, not an error.
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = trimmed.slice(eq + 1).trim();
    // Strip one layer of matching quotes, so a pasted value works either way.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
