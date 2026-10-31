// The app has no rules of its own and runs nothing of the CLI's: it imports only the factory's shareable task code,
// and never the run folder's store, the Keychain, migrations, machines or anything that starts processes.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";

const WEB = resolve(import.meta.dirname, "../..");
const ALLOWED = new Set([
  "lib/tasks/model.ts",
  "lib/tasks/store.ts",
  "lib/tasks/mongo.ts",
  "lib/tasks/requests.ts",
  "lib/tasks/decide.ts",
  "lib/tasks/teams.ts",
  "lib/tasks/graph.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (["node_modules", ".next", "tests", "test-results", "playwright-report"].includes(name)) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

test("the app imports only the factory's shareable task code", () => {
  const outside: string[] = [];
  for (const file of sources(WEB)) {
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (!spec || !spec.startsWith(".")) continue;
      const target = relative(resolve(WEB, ".."), resolve(join(file, ".."), spec));
      if (target.startsWith("web/")) continue;
      if (!ALLOWED.has(target)) outside.push(`${relative(WEB, file)} imports ${target}`);
    }
  }
  assert.deepEqual(outside, []);
});

test("nothing in the app starts a process or opens the CLI's store", () => {
  const found = sources(WEB).filter((file) => /child_process|openStore\(|openTeamStore|readUri\(/.test(readFileSync(file, "utf8")));
  assert.deepEqual(
    found.map((f) => relative(WEB, f)),
    []
  );
});
