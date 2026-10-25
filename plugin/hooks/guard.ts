#!/usr/bin/env node
// PreToolUse guard for every agent on an E9G team. The rules are in lib/guard.ts; this entry reads the call and
// fails closed around them. Inert outside a team (and outside setup, E9G_SETUP=1). Otherwise anything that goes
// wrong (a module that doesn't load, rules it can't read, a bug) refuses the call, except reading a file that holds
// no secrets: Claude Code treats any exit but 2 as "go ahead".
// Exit 2 refuses the tool call and tells the agent why.
import { readFileSync } from "node:fs";
import type { HookInput } from "../../lib/session.ts";

if (!process.env.E9G_TEAM && process.env.E9G_SETUP !== "1") process.exit(0);

function refuse(role: string, reason: string): never {
  process.stderr.write(`Refused by the E9G guard (${role || "no role"}): ${reason}`);
  process.exit(2);
}

let input: HookInput = {};
try {
  input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
} catch {
  refuse(process.env.E9G_ROLE ?? "", "the guard couldn't read this tool call, so it doesn't run.");
}

// A Read or Grep that names no secret file, judged with as little as can still load.
async function harmlessRead(): Promise<boolean> {
  const args = input.tool_input ?? {};
  const paths = input.tool_name === "Read" ? [args.file_path] : input.tool_name === "Grep" ? [args.path, args.glob] : null;
  if (!paths) return false;
  try {
    const { isSecretFile } = await import("../../lib/policies.ts");
    return paths.every((path) => path === undefined || !isSecretFile(String(path)));
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
