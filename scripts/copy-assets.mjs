import fs from "node:fs";
import path from "node:path";

/**
 * tsc emits only JavaScript. The schema and the console's static files are
 * loaded relative to their compiled module, so without this the built output
 * fails at runtime on a missing schema.sql or a missing index.html.
 */
const assets = [
  ["src/state/schema.sql", "dist/state/schema.sql"],
  ["src/interface/web", "dist/interface/web"],
];

for (const [from, to] of assets) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
