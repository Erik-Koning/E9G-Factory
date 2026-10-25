// A counting semaphore shared by every worktree of a team: at most `slots` holders of a name at once, the rest wait
// (up to waitMin minutes). A slot whose holder died is taken over. Used for gates (parallel builds starve each
// other into flaky failures), merges (one at a time) and anything that drives the team's shared environment.
// Slots live in <checkout>/.e9g/run/locks/<name>/slot-<i>/ with the holder's pid.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locksDir } from "./paths.mjs";

export const TIMED_OUT = 75;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function take(dir, slots, holder) {
  for (let i = 0; i < slots; i++) {
    const slot = join(dir, `slot-${i}`);
    try {
      mkdirSync(slot);
    } catch {
      let pid = 0;
      try {
        pid = Number(readFileSync(join(slot, "pid"), "utf8"));
      } catch {}
      if (pid && alive(pid)) continue;
      // No pid yet means another process is taking the slot right now, unless that was long ago.
      try {
        if (!pid && Date.now() - statSync(slot).mtimeMs < 10_000) continue;
      } catch {
        continue;
      }
      rmSync(slot, { recursive: true, force: true });
      try {
        mkdirSync(slot);
      } catch {
        continue;
      }
    }
    writeFileSync(join(slot, "pid"), String(process.pid));
    writeFileSync(join(slot, "holder"), `${holder.slice(0, 200)}\n${new Date().toISOString()}\n`);
    return slot;
  }
  return null;
}

// Resolves to a release function, or null when no slot came free in time.
export async function acquire(home, name, { slots = 1, waitMin = 60, holder = "", onWait } = {}) {
  const dir = join(locksDir(home), name);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  let slot = take(dir, slots, holder);
  let told = false;
  while (!slot) {
    if (Date.now() - started > waitMin * 60_000) return null;
    if (!told) {
      onWait?.(`waiting for a ${name} slot (${slots} in use)`);
      told = true;
    }
    await new Promise((done) => setTimeout(done, 2000));
    slot = take(dir, slots, holder);
  }
  return () => rmSync(slot, { recursive: true, force: true });
}

// Runs a command while holding a slot; resolves to its exit code (TIMED_OUT when no slot came free).
// With stdio pipes, onOutput receives what the command prints.
export async function withLock(home, name, command, { slots, waitMin, cwd, env, stdio = "inherit", onOutput } = {}) {
  const release = await acquire(home, name, { slots, waitMin, holder: command.join(" "), onWait: (text) => console.error(`lock: ${text}`) });
  if (!release) {
    console.error(`lock: no ${name} slot came free in ${waitMin} min`);
    return TIMED_OUT;
  }
  return new Promise((done) => {
    const child = spawn(command[0], command.slice(1), { stdio, cwd, env: { ...process.env, ...env } });
    if (onOutput) for (const stream of [child.stdout, child.stderr]) stream?.on("data", onOutput);
    const forward = (signal) => child.kill(signal);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
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
