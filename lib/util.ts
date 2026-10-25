// Small helpers shared by the CLI, the plugin's hooks and the engine.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function localTime(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The parsed file, or the fallback when there is none. The caller names the type it expects.
export function readJson<T = unknown>(path: string): T | null;
export function readJson<T = unknown>(path: string, fallback: T): T;
export function readJson<T>(path: string, fallback: T | null = null): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

// Write through a temporary file, so a reader never sees half a file.
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
export const writeJson = (path: string, value: unknown): void => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

export const hash = (...parts: unknown[]): string =>
  createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 16);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function gitOk(cwd: string, ...args: string[]): boolean {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

// Run a shell command, returning { code, out } with stdout and stderr together.
export function sh(
  command: string,
  { cwd, env, timeoutMs }: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): { code: number; out: string } {
  const result = spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function which(command: string): string | null {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// "45m", "6h", "2d" or a number of minutes.
export function minutes(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)?$/.exec(String(value).trim());
  if (!match) throw new Error(`not a duration: ${value} (use 45m, 6h or 2d)`);
  const unit = { m: 1, min: 1, h: 60, d: 1440 } as const;
  return Number(match[1]) * unit[(match[2] ?? "m") as keyof typeof unit];
}

export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A command's options: --flag value, --flag=value, a bare --flag (true), a repeated one (a list), and what follows --.
export type Options = { [key: string]: string | true | string[] | undefined };

// Options after the positional arguments: --flag value, --flag=value, or a bare --flag (true).
export function parseArgs(
  argv: string[],
  { booleans = [], repeat = [] }: { booleans?: string[]; repeat?: string[] } = {}
): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      options["--"] = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value: string | true | undefined = inline;
    if (value === undefined) value = booleans.includes(key) || i + 1 >= argv.length || argv[i + 1]?.startsWith("--") ? true : (argv[++i] as string);
    if (repeat.includes(key)) {
      const list = options[key];
      options[key] = [...(Array.isArray(list) ? list : []), String(value)];
    } else options[key] = value;
  }
  return { positional, options };
}

// An option's value as text (a bare --flag has none), and as a list.
export const text = (value: Options[string]): string | undefined => (typeof value === "string" ? value : undefined);
export const list = (value: Options[string]): string[] => (Array.isArray(value) ? value : typeof value === "string" ? [value] : []);

export function die(message: string, code = 2): never {
  console.error(`e9g: ${message}`);
  process.exit(code);
}
