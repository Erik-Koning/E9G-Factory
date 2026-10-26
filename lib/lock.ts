// A counting semaphore shared by every worktree of a team: at most `slots` holders of a name at once, the rest wait
// (up to waitMin minutes). A slot whose holder died is taken over. Used for gates (parallel builds starve each
// other into flaky failures), merges (one at a time) and anything that drives the team's shared environment.
// Slots live in <checkout>/.e9g/run/locks/<name>/slot-<i>/: `pid` (the holder's pid, which earlier versions read)
// and `owner` (a token for this one holding, and the holder's start time, so a reused pid doesn't count).
//
// A slot directory appears whole: it's filled under another name and renamed into place, which fails while
// another holder's slot is there. A dead holder's slot is renamed to <slot>.stale-<its token>; only one taker can
// make that rename, and a slow taker that judged the same slot stale can't move the next holder's slot there.
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { locksDir } from "./paths.ts";

export const TIMED_OUT = 75;

interface Owner {
  token: string;
  pid: number;
  started: string | null;
  holder: string;
  at: string;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but another user's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// When a process started, as ps prints it: in the C locale and in UTC, so every caller prints it the same way (a
// member's TZ, or a TZ in team.json's vars, must not make a live holder look like another process).
function startOf(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
let ownStart: string | null | undefined;
const myStart = (): string | null => (ownStart === undefined ? (ownStart = startOf(process.pid)) : ownStart);

function readOwner(slot: string): Owner | null {
  try {
    return JSON.parse(readFileSync(join(slot, "owner"), "utf8")) as Owner;
  } catch {
    return null;
  }
}
function readPid(slot: string): number {
  try {
    return Number(readFileSync(join(slot, "pid"), "utf8")) || 0;
  } catch {
    return 0;
  }
}
const stat = (path: string): { ino: number; mtimeMs: number } | null => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
const mtime = (path: string): number | null => stat(path)?.mtimeMs ?? null;

// Who holds a slot: an id for this holding, and whether its holder is gone. null when the slot is free.
function inspect(slot: string): { id: string; gone: boolean } | null {
  const before = stat(slot);
  if (!before) return null;
  const owner = readOwner(slot);
  const pid = owner?.pid ?? readPid(slot);
  const written = mtime(join(slot, owner ? "owner" : "pid")) ?? before.mtimeMs;
  // It changed hands while this looked: someone holds it now.
  if (stat(slot)?.ino !== before.ino) return { id: "", gone: false };
  const id = owner?.token ?? `ino-${before.ino}`;
  // Written before the machine last started: whatever pid it names now is another process.
  if (written < Date.now() - uptime() * 1000 - 2000) return { id, gone: true };
  // An earlier version's slot with no pid yet: someone is taking it right now, unless that was long ago.
  if (!pid) return { id, gone: Date.now() - before.mtimeMs > 10_000 };
  if (!alive(pid)) return { id, gone: true };
  if (owner?.started) {
    const now = startOf(pid);
    if (now !== null && now !== owner.started) return { id, gone: true };
  }
  return { id, gone: false };
}

// Leftovers of earlier takeovers and crashed takers, beside the slot, once nobody can still be acting on them.
function sweep(slot: string): void {
  const dir = dirname(slot);
  const prefix = `${basename(slot)}.`;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {}
  for (const name of names) {
    const path = join(dir, name);
    const at = mtime(join(path, "taken")) ?? mtime(path) ?? Date.now();
    if (Date.now() - at > 10 * 60_000) rmSync(path, { recursive: true, force: true });
  }
}

// Takes the slot directory `slot`; returns this holding's token, or null when someone else holds it.
export function takeSlot(slot: string, holder = ""): string | null {
  const token = `${process.pid}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
  const fresh = `${slot}.new-${token}`;
  mkdirSync(fresh, { recursive: true });
  try {
    writeFileSync(join(fresh, "pid"), String(process.pid));
    const owner: Owner = { token, pid: process.pid, started: myStart(), holder: holder.slice(0, 200), at: new Date().toISOString() };
    writeFileSync(join(fresh, "owner"), `${JSON.stringify(owner)}\n`);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(fresh, slot);
        // Belt and braces: the slot is ours only if it names us.
        return readOwner(slot)?.token === token ? token : null;
      } catch {}
      const held = inspect(slot);
      if (held === null) continue;
      if (!held.gone) return null;
      const grave = `${slot}.stale-${held.id}`;
      try {
        renameSync(slot, grave);
      } catch {
        return null;
      }
      try {
        writeFileSync(join(grave, "taken"), new Date().toISOString());
      } catch {}
      sweep(slot);
    }
    return null;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

// Gives back a slot, only if it's still this holding's.
export function releaseSlot(slot: string, token: string): void {
  if (readOwner(slot)?.token !== token) return;
  const gone = `${slot}.released-${token}`;
  try {
    renameSync(slot, gone);
  } catch {
    return;
  }
  rmSync(gone, { recursive: true, force: true });
}

// Waits for one of the slot directories in `paths`; resolves to a release function, or null when none came free in
// waitMin minutes.
export async function acquireSlot(
  paths: string[],
  { waitMin = 60, holder = "", onWait, pollMs = 2000 }: { waitMin?: number; holder?: string; onWait?: (text: string) => void; pollMs?: number } = {}
): Promise<(() => void) | null> {
  for (const path of paths) mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  let told = false;
  for (;;) {
    for (const path of paths) {
      const token = takeSlot(path, holder);
      if (token) return () => releaseSlot(path, token);
    }
    if (Date.now() - started > waitMin * 60_000) return null;
    if (!told) {
      onWait?.(`${paths.length} in use`);
      told = true;
    }
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

// Resolves to a release function, or null when no slot came free in time.
export async function acquire(
  home: string,
  name: string,
  {
    slots = 1,
    waitMin = 60,
    holder = "",
    onWait,
  }: { slots?: number | undefined; waitMin?: number | undefined; holder?: string; onWait?: (text: string) => void } = {}
): Promise<(() => void) | null> {
  const dir = join(locksDir(home), name);
  const paths = Array.from({ length: Math.max(1, slots) }, (_, i) => join(dir, `slot-${i}`));
  return acquireSlot(paths, { waitMin, holder, onWait: () => onWait?.(`waiting for a ${name} slot (${slots} in use)`) });
}

// Runs a command while holding a slot; resolves to its exit code (TIMED_OUT when no slot came free, after calling
// onTimeout, so a caller can tell that from a command that exits 75). With stdio pipes, onOutput receives what the
// command prints.
export async function withLock(
  home: string,
  name: string,
  command: string[],
  {
    slots,
    waitMin = 60,
    cwd,
    env,
    stdio = "inherit",
    onOutput,
    onTimeout,
  }: {
    slots?: number | undefined;
    waitMin?: number | undefined;
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdio?: StdioOptions;
    onOutput?: (chunk: Buffer) => void;
    onTimeout?: () => void;
  } = {}
): Promise<number> {
  const release = await acquire(home, name, { slots, waitMin, holder: command.join(" "), onWait: (text) => console.error(`lock: ${text}`) });
  if (!release) {
    console.error(`lock: no ${name} slot came free in ${waitMin} min`);
    onTimeout?.();
    return TIMED_OUT;
  }
  return new Promise<number>((done) => {
    const child = spawn(command[0] ?? "", command.slice(1), { stdio, env: { ...process.env, ...env }, ...(cwd === undefined ? {} : { cwd }) });
    if (onOutput) for (const stream of [child.stdout, child.stderr]) stream?.on("data", onOutput);
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);
    child.on("exit", (code, signal) => {
      release();
      done(code ?? (signal ? 1 : 0));
    });
    child.on("error", (error) => {
      release();
      console.error(`lock: ${error.message}`);
      done(127);
    });
  });
}
