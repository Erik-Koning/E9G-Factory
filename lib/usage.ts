// What a team used and what it cost, day by day: read from the Claude transcripts of its checkout and the worktrees made
// from it (as a6g metrics reads them), only what each transcript added since the last read. Each request counts once,
// for its role (the transcript's agent), its model, and its task (from the branch it ran on: a6g/b142-… is #142; the
// planner's, on the integration branch, is no task's), priced at the API-equivalent rate (prices.ts).
//
// Each machine keeps its own totals and where it stopped in each transcript in one file of the run folder
// (usage.json, written whole, so the two never disagree), and publishes its totals to the team's store, a document per
// day and machine, replaced each time: publishing again never counts twice. Budgets and the web app add every
// machine's (tasks/spend.ts).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { roleOfAgent } from "./config.ts";
import { costOf, modelKey, priced } from "./prices.ts";
import { ticketOf } from "./tasks/model.ts";
import { dayOf, round, type UsageDay, type UsageRow } from "./tasks/spend.ts";
import { readJson, writeFileAtomic } from "./util.ts";

interface Cursor {
  // Bytes read: every complete line before this offset has been counted.
  at: number;
  role: string | null;
  // The newest message ids counted: a request streams several lines under one id, and they can straddle two reads.
  seen: string[];
}
interface State {
  cursors: Record<string, Cursor>;
  days: Record<string, UsageRow[]>;
}

interface Line {
  type?: string;
  agentSetting?: string;
  timestamp?: string;
  gitBranch?: string;
  cwd?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      speed?: string;
    };
  };
}

const stateFile = (run: string): string => join(run, "usage.json");
// How Claude Code names a folder's transcripts: every character that isn't a letter or a digit becomes "-".
export const encodePath = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, "-");
const encode = encodePath;

// The transcript folders of a checkout and its worktrees, removed ones included (their transcripts stay). The names
// can't tell a worktree of "app" from one of "app-admin": collectUsage keeps only lines that ran in the team's own.
export function transcriptDirs(home: string, worktrees: string, projects = join(homedir(), ".claude", "projects")): string[] {
  if (!existsSync(projects)) return [];
  const prefix = `${encode(worktrees)}-`;
  return readdirSync(projects)
    .filter((name) => name === encode(home) || name.startsWith(prefix))
    .map((name) => join(projects, name));
}

// Reads what the transcripts added since the last call, adds it to the run folder's totals, and resolves to the days
// that changed (this machine's, whole), for the store.
export function collectUsage(opts: {
  run: string;
  team: string;
  machine: string;
  dirs: string[];
  home?: string;
  worktrees?: string;
  now?: Date;
}): UsageDay[] {
  const state = readJson<State>(stateFile(opts.run), { cursors: {}, days: {} });
  // A line that says where it ran must have run in the checkout or one of its worktrees.
  const ours = (cwd: string | undefined): boolean =>
    !cwd || !opts.home || cwd === opts.home || cwd.startsWith(`${opts.home}/`) || (opts.worktrees !== undefined && cwd.startsWith(`${opts.worktrees}/`));
  const changed = new Set<string>();
  for (const dir of opts.dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const cursor = state.cursors[path] ?? { at: 0, role: null, seen: [] };
      const read = readFrom(path, cursor.at);
      if (!read) continue;
      const { text, from } = read;
      // Only complete lines: a line still being written is read next time.
      const end = text.lastIndexOf("\n");
      if (end < 0) continue;
      const seen = new Set(cursor.seen);
      for (const raw of text.slice(0, end).split("\n")) {
        if (!raw) continue;
        let line: Line;
        try {
          line = JSON.parse(raw) as Line;
        } catch {
          continue;
        }
        if (line.type === "agent-setting") cursor.role = roleOfAgent(line.agentSetting) ?? cursor.role;
        const message = line.message;
        if (line.type !== "assistant" || !message?.id || seen.has(message.id) || !ours(line.cwd)) continue;
        seen.add(message.id);
        cursor.seen = [...cursor.seen, message.id].slice(-50);
        // Not one of the team's agents (no --agent), or a line Claude Code made up itself.
        if (!cursor.role || !message.model || message.model.startsWith("<")) continue;
        const at = new Date(line.timestamp ?? "");
        if (Number.isNaN(at.getTime())) continue;
        const usage = message.usage ?? {};
        const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        const write5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0);
        const tokens = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite5m: write5m,
          cacheWrite1h: write1h,
          fast: usage.speed === "fast",
        };
        const day = dayOf(at);
        const model = modelKey(message.model);
        const task = line.gitBranch ? (ticketOf(line.gitBranch, line.gitBranch.split("/")[0] ?? "") ?? null) : null;
        const rows = (state.days[day] ??= []);
        let row = rows.find((r) => r.role === cursor.role && r.model === model && r.task === task);
        if (!row) {
          row = { role: cursor.role, model, task, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0 };
          rows.push(row);
        }
        row.requests += 1;
        row.input += tokens.input;
        row.output += tokens.output;
        row.cacheRead += tokens.cacheRead;
        row.cacheWrite += write5m + write1h;
        if (priced(model)) row.cost = round(row.cost + (costOf(model, tokens) ?? 0));
        else row.unpriced += 1;
        changed.add(day);
      }
      cursor.at = from + Buffer.byteLength(text.slice(0, end + 1));
      state.cursors[path] = cursor;
    }
  }
  if (changed.size || !existsSync(stateFile(opts.run))) writeFileAtomic(stateFile(opts.run), `${JSON.stringify(state)}\n`);
  const updatedAt = (opts.now ?? new Date()).toISOString();
  return [...changed].sort().map((day) => ({ team: opts.team, day, machine: opts.machine, rows: state.days[day] ?? [], updatedAt }));
}

// Every day this machine has counted, as the store keeps them (to publish them all again, after a store moved).
export function countedDays(run: string, team: string, machine: string, now = new Date()): UsageDay[] {
  const state = readJson<State>(stateFile(run), { cursors: {}, days: {} });
  return Object.keys(state.days)
    .sort()
    .map((day) => ({ team, day, machine, rows: state.days[day] ?? [], updatedAt: now.toISOString() }));
}

// The text after byte `at` and where it starts, or null when there's nothing new. A transcript shorter than where the
// last read stopped was replaced: it's read from the start.
function readFrom(path: string, at: number): { text: string; from: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const from = size < at ? 0 : at;
    if (size === from) return null;
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return { text: buffer.toString("utf8"), from };
  } finally {
    closeSync(fd);
  }
}
