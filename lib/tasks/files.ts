// The task graph as files in the team's run folder (~/.e9g/runs/<team>/tasks/142.json, requests/r12.json, …), one
// document each, where the launchd watchdog can read them and only the factory's commands write them (the guard
// refuses agents the run folder). Creating and replacing hold the collection's lock, so ids are never given twice and
// a replace sees the version it checks.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireSlot } from "../lock.ts";
import { writeJson } from "../util.ts";
import type { Doc } from "./model.ts";
import type { Collection, Store } from "./store.ts";

const PREFIX = { tasks: "", requests: "r", stakeholders: "s", cycles: "c" } as const;

function collection<T extends Doc>(dir: string, prefix: string): Collection<T> {
  const file = (id: string) => join(dir, `${id}.json`);
  // Only canonical numbers (7, never 007): the id and the file's name must be one string.
  const named = new RegExp(`^${prefix}(0|[1-9]\\d*)\\.json$`);
  const read = (path: string): T | null => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  };
  const locked = async <R>(fn: () => R): Promise<R> => {
    const release = await acquireSlot([join(dir, ".lock")], { waitMin: 1, holder: "task store", pollMs: 25 });
    if (!release) throw new Error(`the task store at ${dir} stayed locked for a minute`);
    try {
      return fn();
    } finally {
      release();
    }
  };
  const counter = join(dir, ".next");
  const counted = (): number => (existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0);
  const ids = (): number[] =>
    existsSync(dir)
      ? readdirSync(dir)
          .flatMap((name) => named.exec(name)?.[1] ?? [])
          .map(Number)
      : [];
  return {
    async all() {
      return ids()
        .sort((a, b) => a - b)
        .flatMap((n) => read(file(`${prefix}${n}`)) ?? []);
    },
    async get(id) {
      return named.test(`${id}.json`) ? read(file(id)) : null;
    },
    create(fields) {
      return locked(() => {
        const next = Math.max(counted(), ...ids().map((n) => n + 1), 1);
        const doc = { ...fields, id: `${prefix}${next}`, version: 1 } as T;
        writeJson(file(doc.id), doc);
        writeFileSync(counter, String(next + 1));
        return doc;
      });
    },
    createAs(id, fields) {
      const match = named.exec(`${id}.json`);
      if (!match) return Promise.resolve(null);
      return locked(() => {
        if (existsSync(file(id))) return null;
        const doc = { ...fields, id, version: 1 } as T;
        writeJson(file(id), doc);
        writeFileSync(counter, String(Math.max(counted(), Number(match[1]) + 1)));
        return doc;
      });
    },
    replace(doc) {
      return locked(() => {
        const current = read(file(doc.id));
        if (!current || current.version !== doc.version) return null;
        const written = { ...doc, version: doc.version + 1 };
        writeJson(file(doc.id), written);
        return written;
      });
    },
  };
}

// The folder beside a run folder for what agents never read: ~/.e9g/runs/<team>.private/.
export const privateDir = (run: string): string => join(dirname(run), `${basename(run)}.private`);

export function fileStore(run: string, _team: string): Store {
  return {
    kind: "files",
    tasks: collection(join(run, "tasks"), PREFIX.tasks),
    requests: collection(join(run, "requests"), PREFIX.requests),
    // Stakeholders' names and addresses live beside the run folder, not in it: members have $E9G_RUN and search it, and
    // the guard refuses the private folder whatever path or glob names it (Article 8).
    stakeholders: collection(join(privateDir(run), "stakeholders"), PREFIX.stakeholders),
    cycles: collection(join(run, "cycles"), PREFIX.cycles),
    publish: async () => {},
    report: async () => {},
    team: async () => null,
    close: async () => {},
  };
}
