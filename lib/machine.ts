// This machine's name in a team's task graph: who holds a claim, and whether this is the team's lead (the always-on
// machine that merges). ~/.e9g/machine.json, which `e9g connect mongo --machine <name>` writes, or the host's name.
import { hostname } from "node:os";
import { join } from "node:path";
import { E9G_HOME } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

export const MACHINE_FILE = join(E9G_HOME, "machine.json");
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function machineName(): string {
  try {
    const saved = readJson<{ name?: unknown }>(MACHINE_FILE, {}).name;
    if (typeof saved === "string" && MACHINE_NAME.test(saved)) return saved;
  } catch {}
  return (
    hostname()
      .replace(/\.local$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 41) || "this-mac"
  );
}

export const saveMachineName = (name: string): void => writeJson(MACHINE_FILE, { name });
