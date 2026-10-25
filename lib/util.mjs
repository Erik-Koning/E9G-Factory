// Small helpers shared by the CLI, the plugin's hooks and the engine.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function localTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);

// Write through a temporary file, so a reader never sees half a file.
export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
export const writeJson = (path, value) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

export const hash = (...parts) =>
  createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 16);

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function gitOk(cwd, ...args) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

// Run a shell command, returning { code, out } with stdout and stderr together.
export function sh(command, { cwd, env, timeoutMs } = {}) {
  const result = spawnSync("sh", ["-c", command], { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout: timeoutMs });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function which(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// "45m", "6h", "2d" or a number of minutes.
export function minutes(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/.exec(String(value).trim());
  if (!match) throw new Error(`not a duration: ${value} (use 45m, 6h or 2d)`);
  return Number(match[1]) * { m: 1, min: 1, h: 60, d: 1440 }[match[2] ?? "m"];
}

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options after the positional arguments: --flag value, --flag=value, or a bare --flag (true).
export function parseArgs(argv, { booleans = [], repeat = [] } = {}) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      options["--"] = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value = inline;
    if (value === undefined) value = booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith("--") ? true : argv[++i];
    if (repeat.includes(key)) (options[key] ??= []).push(value);
    else options[key] = value;
  }
  return { positional, options };
}

export function die(message, code = 2) {
  console.error(`e9g: ${message}`);
  process.exit(code);
}
