import { e9g, ROOT } from "./helpers.mjs";
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROLES } from "../lib/config.mjs";

const json = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

describe("release", () => {
  test("the plugin's version is the package's", () => {
    assert.equal(json("plugin/.claude-plugin/plugin.json").version, json("package.json").version);
    assert.equal(json("plugin/.claude-plugin/plugin.json").name, "e9g", "agents are e9g:<role>");
  });

  test("the T3 Code and Claude Code ranges are declared", () => {
    const { e9g: needs } = json("package.json");
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
    const { hooks } = json("plugin/hooks/hooks.json");
    const commands = Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    assert.ok(commands.length >= 5);
    for (const command of commands) {
      const file = /\$\{CLAUDE_PLUGIN_ROOT\}\/([\w/.-]+)/.exec(command)?.[1];
      assert.ok(file && existsSync(join(ROOT, "plugin", file)), command);
    }
  });

  test("the constitution has its articles section", () => {
    const text = readFileSync(join(ROOT, "CONSTITUTION.md"), "utf8");
    assert.match(text, /<!-- e9g:articles:start -->[\s\S]+Article 12[\s\S]+<!-- e9g:articles:end -->/);
  });

  test("scripts are executable", () => {
    for (const file of ["bin/e9g.mjs", ...readdirSync(join(ROOT, "templates/team/adapters")).map((f) => `templates/team/adapters/${f}`)])
      assert.doesNotThrow(() => accessSync(join(ROOT, file), constants.X_OK), file);
  });

  test("the CLI answers help, its version and an unknown command", async () => {
    const help = await e9g(["help"]);
    assert.equal(help.code, 0);
    for (const command of ["doctor", "init", "check", "register", "start", "merge", "verdict", "pages", "self-install"])
      assert.match(help.out, new RegExp(`e9g ${command}\\b`));
    assert.equal((await e9g(["--version"])).out.trim(), json("package.json").version);
    assert.equal((await e9g(["teleport"])).code, 2);
  });
});
