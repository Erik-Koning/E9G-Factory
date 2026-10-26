#!/usr/bin/env node
// PreToolUse guard for every agent on an E9G team. The rules are in lib/guard.ts; this entry reads the call and
// fails closed around them. Inert outside a team (and outside setup, E9G_SETUP=1). Otherwise anything that goes
// wrong (input it can't read, a module that doesn't load, rules it can't read, a bug) refuses the call, except reading
// a file that holds no secrets: Claude Code treats any exit but 2 as "go ahead" (hooks.json's onFailure: block also
// refuses when node itself can't run this).
// Exit 2 refuses the tool call and tells the agent why.
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HookInput } from "../../lib/session.ts";

if (!process.env.E9G_TEAM && process.env.E9G_SETUP !== "1") process.exit(0);

function refuse(role: string, reason: string): never {
  process.stderr.write(`Refused by the E9G guard (${role || "no role"}): ${reason}`);
  process.exit(2);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
let input: HookInput = {};
try {
  const parsed: unknown = JSON.parse(readFileSync(0, "utf8"));
  // A call is an object with a tool's name, and its input (when there is one) an object too.
  if (!isObject(parsed) || typeof parsed.tool_name !== "string" || (parsed.tool_input !== undefined && !isObject(parsed.tool_input)))
    throw new Error("not a tool call");
  input = parsed as HookInput;
} catch {
  refuse(process.env.E9G_ROLE ?? "", "the guard couldn't read this tool call, so it doesn't run.");
}

// A path with its symlinks and .. resolved, as far as it exists.
function canonical(path: string): string {
  const rest: string[] = [];
  for (let dir = resolve(input.cwd ?? process.cwd(), path); ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...rest);
    } catch {}
    if (dirname(dir) === dir) return resolve(path);
    rest.unshift(basename(dir));
  }
}

// A Read, or a Grep without a glob, that names no secret file (as written, without its wildcards, or where its
// symlinks lead), judged with as little as can still load. A glob can take in what Grep otherwise skips.
async function harmlessRead(): Promise<boolean> {
  const args = input.tool_input ?? {};
  if (input.tool_name === "Grep" && args.glob !== undefined && args.glob !== "") return false;
  const paths = input.tool_name === "Read" ? [args.file_path] : input.tool_name === "Grep" ? [args.path] : null;
  if (!paths) return false;
  try {
    const { isSecretFile } = await import("../../lib/policies.ts");
    return paths.every((path) => {
      if (path === undefined || path === "") return true;
      const named = String(path);
      return ![named, named.replace(/\*+|\?|\[[^\]/]*\]/g, ""), canonical(named)].some(isSecretFile);
    });
  } catch {
    return false;
  }
}

let guard: typeof import("../../lib/guard.ts") | null = null;
try {
  guard = await import("../../lib/guard.ts");
  guard.check(input);
} catch (error) {
  if (guard && error instanceof guard.Refusal) refuse(error.role, error.message);
  if (await harmlessRead()) process.exit(0);
  const why = String((error as Error)?.message ?? error)
    .split("\n")
    .slice(0, 4)
    .join(" ");
  refuse(process.env.E9G_ROLE ?? "", `the guard itself failed (${why}), so nothing but reading runs until the operator fixes it.`);
}
process.exit(0);
