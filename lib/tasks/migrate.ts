// Moving a team's task graph between stores (e9g task migrate): every task, request, stakeholder and closed cycle,
// each keeping its id, into a store that has none of the team's yet. A file store moved from is marked, and opening it
// again is refused, so a team can't go on writing to two graphs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../util.ts";
import { type Doc, Refused } from "./model.ts";
import type { Collection, Store } from "./store.ts";

const NAMES = ["tasks", "requests", "stakeholders", "cycles"] as const;
export type Counts = Record<(typeof NAMES)[number], number>;

// Where a file store says it moved to, if it did.
export const movedMark = (run: string): string => join(run, "tasks", ".moved.json");
export function movedTo(run: string): { to: string; at: string } | null {
  if (!existsSync(movedMark(run))) return null;
  try {
    return JSON.parse(readFileSync(movedMark(run), "utf8")) as { to: string; at: string };
  } catch {
    return { to: "another store", at: "" };
  }
}

// How many documents each collection holds.
export async function countsOf(store: Store): Promise<Counts> {
  const counts = {} as Counts;
  for (const name of NAMES) counts[name] = (await store[name].all()).length;
  return counts;
}

// Copies everything in `from` into `to`, which must hold nothing of the team's, and checks that it all arrived.
export async function migrate(from: Store, to: Store): Promise<Counts> {
  const there = await countsOf(to);
  const taken = NAMES.filter((name) => there[name] > 0);
  if (taken.length)
    throw new Refused(`the ${to.kind} store already has this team's ${taken.map((name) => `${name} (${there[name]})`).join(", ")}; nothing was copied`);
  for (const name of NAMES) {
    const target = to[name] as Collection<Doc>;
    for (const { id, version: _version, ...fields } of await (from[name] as Collection<Doc>).all())
      if (!(await target.createAs(id, fields))) throw new Refused(`${name} ${id} is taken in the ${to.kind} store; copying stopped there`);
  }
  const copied = await countsOf(to);
  const expected = await countsOf(from);
  const short = NAMES.filter((name) => copied[name] !== expected[name]);
  if (short.length) throw new Refused(`the copy is short: ${short.map((name) => `${name} ${copied[name]} of ${expected[name]}`).join(", ")}`);
  return copied;
}

export const markMoved = (run: string, to: string): void => writeJson(movedMark(run), { to, at: new Date().toISOString() });
