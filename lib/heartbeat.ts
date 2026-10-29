// The heartbeat: an outside check (healthchecks.io, Better Stack, Cronitor, UptimeRobot, Uptime Kuma, …) that the
// watchdog pings at the end of every run in which T3 Code answers. When the pings stop (this Mac is off, asleep or
// at the login screen after a restart, the watchdog is unloaded or keeps failing, or T3 Code won't start), the
// service tells the operator: the one alert the factory can't send itself. `e9g connect heartbeat <url>` sets it up.
// The URL is in ~/.e9g/heartbeat.json, not the Keychain: it isn't a key, and whoever holds it can only ping it.
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { E9G_HOME, PACKAGE } from "./paths.ts";
import { readJson, writeFileAtomic, writeJson } from "./util.ts";

export const HEARTBEAT_FILE = join(E9G_HOME, "heartbeat.json");
// Its file time is when a ping last went through.
const LAST = join(E9G_HOME, ".stamp-heartbeat");

export interface HeartbeatSettings {
  url: string;
  connectedAt: string;
}

export const heartbeatSettings = (): HeartbeatSettings | null => readJson<HeartbeatSettings>(HEARTBEAT_FILE);
export const saveHeartbeat = (settings: HeartbeatSettings): void => writeJson(HEARTBEAT_FILE, settings);
export function forgetHeartbeat(): void {
  rmSync(HEARTBEAT_FILE, { force: true });
  rmSync(LAST, { force: true });
}

// An http(s) URL, or null.
export function heartbeatUrl(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// The service's host, to show without the part that names the check.
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "the heartbeat";
  }
};

export const lastPing = (): Date | null => (existsSync(LAST) ? statSync(LAST).mtime : null);

// One ping: null when the service took it, otherwise what went wrong.
export async function ping(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": `e9g/${PACKAGE.version}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return `it answered ${response.status}`;
  } catch (error) {
    return `it didn't answer (${(error as Error).message})`;
  }
  writeFileAtomic(LAST, "");
  return null;
}
