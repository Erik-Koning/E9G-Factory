import { a6g, ROOT } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROLES } from "../lib/config.ts";

const json = <T = Record<string, string>>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;

describe("release", () => {
  test("the plugin's version is the package's", () => {
    assert.equal(json("plugin/.claude-plugin/plugin.json").version, json("package.json").version);
    assert.equal(json("plugin/.claude-plugin/plugin.json").name, "a6g", "agents are a6g:<role>");
  });

  test("the T3 Code and Claude Code ranges are declared", () => {
    const { a6g: needs } = json<{ a6g: { t3code: string; claudeCode: string } }>("package.json");
    assert.match(needs.t3code, /\d+\.\d+\.\d+/);
    assert.match(needs.claudeCode, /\d+\.\d+\.\d+/);
  });

  test("every role has a prompt, and every prompt a role", () => {
    const files = readdirSync(join(ROOT, "plugin/agents")).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const text = readFileSync(join(ROOT, "plugin/agents", file), "utf8");
      const name = /^---\n[\s\S]*?^name:\s*(\S+)/m.exec(text)?.[1];
      assert.equal(name, file.replace(/\.md$/, ""), `${file}: frontmatter name`);
      assert.match(text, /^description:\s*\S/m, `${file}: description`);
      if (name !== "setup") assert.ok(ROLES[name], `${file}: a role the factory knows`);
    }
    for (const role of Object.keys(ROLES)) assert.ok(files.includes(`${role}.md`), `${role} has a prompt`);
  });

  test("every hook command points at a file that exists", () => {
    const { hooks } = json<{ hooks: Record<string, { hooks: { command: string }[] }[]> }>("plugin/hooks/hooks.json");
    const commands = Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    assert.ok(commands.length >= 5);
    for (const command of commands) {
      const file = /node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w.-]+\.ts)"/.exec(command)?.[1];
      assert.ok(file && existsSync(join(ROOT, "plugin", file)), command);
      assert.match(command, /^NODE_COMPILE_CACHE="\$\{CLAUDE_PLUGIN_ROOT\}\/\.cache" A6G_NODE_CACHE=1 node /, `${command}: with the compile cache`);
    }
  });

  test("the constitution has its articles section", () => {
    const text = readFileSync(join(ROOT, "CONSTITUTION.md"), "utf8");
    assert.match(text, /<!-- a6g:articles:start -->[\s\S]+Article 12[\s\S]+<!-- a6g:articles:end -->/);
  });

  test("scripts are executable", () => {
    for (const file of ["bin/a6g.ts", ...readdirSync(join(ROOT, "templates/team/adapters")).map((f) => `templates/team/adapters/${f}`)])
      assert.doesNotThrow(() => accessSync(join(ROOT, file), constants.X_OK), file);
  });

  test("the CLI answers help, its version and an unknown command", async () => {
    const help = await a6g(["help"]);
    assert.equal(help.code, 0);
    for (const command of ["doctor", "init", "check", "register", "start", "merge", "verdict", "pages", "self-install"])
      assert.match(help.out, new RegExp(`a6g ${command}\\b`));
    assert.equal((await a6g(["--version"])).out.trim(), json("package.json").version);
    assert.equal((await a6g(["teleport"])).code, 2);
  });
});

describe("the guard fails closed", () => {
  test("Claude Code refuses the call when the guard's hook fails or times out (onFailure: block)", () => {
    const { hooks } = json<{ hooks: Record<string, { hooks: { command: string; onFailure?: string }[] }[]> }>("plugin/hooks/hooks.json");
    const guard = (hooks["PreToolUse"] ?? []).flatMap((entry) => entry.hooks).find((hook) => hook.command.includes("hooks/guard.ts"));
    assert.equal(guard?.onFailure, "block");
  });

  test("a member's environment names the factory's home, so its hooks guard it wherever it is", async () => {
    const { memberEnvironment } = await import("../lib/commands/team.ts");
    const { normalize } = await import("../lib/config.ts");
    const { A6G_HOME } = await import("../lib/paths.ts");
    const team = normalize({ name: "app", branch: "a6g/next" }, "/tmp/app").team;
    assert.equal(memberEnvironment(team, "builder", { home: "/tmp/app", run: "/tmp/run", version: "0.3.0" })["A6G_HOME"], A6G_HOME);
  });
});
