// The task graph as a BetterDiagrams document, generated from the tasks and never edited: a band per journey with its
// tasks inside, a band for the tasks in no journey, columns by how many tasks must come first, and an edge for each
// dependency. Open it with `npx @mosphere/better-diagrams <file>`; e9g serve draws the same layout itself.
import { claimOrder, journeyDue, type Kind, type Task } from "./model.ts";

const W = 220;
const H = 76;
const COL = W + 48;
const ROW = H + 20;
const PAD = 24;
const TOP = 44;

const ICON: Record<Kind, string> = {
  feature: "code",
  bug: "activity",
  ux: "eye",
  test: "check",
  "test-infra": "gear",
  chore: "gear",
  research: "search",
  journey: "layers",
};

export interface Placed {
  task: Task;
  band: string;
  col: number;
  row: number;
}
export interface Band {
  id: string;
  label: string;
  journey: Task | null;
  cols: number;
  rows: number;
}

// Where each task goes: its band (its journey, or none) and its column (the longest chain of tasks before it).
export function layout(tasks: Task[], { all = false } = {}): { bands: Band[]; placed: Placed[] } {
  const shown = tasks.filter((t) => all || t.status !== "rejected");
  const byId = new Map(shown.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (t: Task, seen = new Set<string>()): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const before = t.after.flatMap((id) => byId.get(id) ?? []);
    const d = before.length ? 1 + Math.max(...before.map((b) => depthOf(b, seen))) : 0;
    depth.set(t.id, d);
    return d;
  };
  const journeys = shown.filter((t) => t.kind === "journey");
  const bands: Band[] = [
    ...journeys.map((j) => ({ id: `j${j.id}`, label: `#${j.id} ${j.title}`, journey: j, cols: 0, rows: 0 })),
    { id: "none", label: "Not in a journey", journey: null, cols: 0, rows: 0 },
  ];
  const placed: Placed[] = [];
  for (const band of bands) {
    const members = shown.filter((t) => t.kind !== "journey" && (band.journey ? t.parent === band.journey.id : !t.parent || !byId.has(t.parent)));
    const columns = new Map<number, Task[]>();
    for (const t of members) columns.set(depthOf(t), [...(columns.get(depthOf(t)) ?? []), t]);
    for (const [col, list] of columns) list.sort(claimOrder).forEach((task, row) => placed.push({ task, band: band.id, col, row }));
    band.cols = Math.max(1, ...[...columns.keys()].map((c) => c + 1));
    band.rows = Math.max(1, ...[...columns.values()].map((l) => l.length));
  }
  return { bands: bands.filter((b) => b.journey || placed.some((p) => p.band === b.id)), placed };
}

const label = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function betterDiagram(tasks: Task[], { title, all = false }: { title: string; all?: boolean }): Record<string, unknown> {
  const { bands, placed } = layout(tasks, { all });
  const nodes: Record<string, unknown>[] = [];
  let y = 40;
  for (const band of bands) {
    const w = PAD * 2 + band.cols * COL - (COL - W);
    const h = TOP + band.rows * ROW - (ROW - H) + PAD;
    const j = band.journey;
    nodes.push({
      id: band.id,
      label: label(band.label, 60),
      kind: "group",
      icon: j ? ICON.journey : "folder",
      x: 40,
      y,
      w,
      h,
      ...(j ? { description: journeyDue(j, tasks) ? "due its verification" : j.status } : {}),
    });
    for (const p of placed.filter((p) => p.band === band.id)) {
      const t = p.task;
      nodes.push({
        id: `t${t.id}`,
        label: label(`#${t.id} ${t.title}`, 48),
        kind: "service",
        icon: ICON[t.kind],
        x: PAD + p.col * COL,
        y: TOP + p.row * ROW,
        w: W,
        h: H,
        parentId: band.id,
        description: [t.status, t.severity, t.priority === null ? null : `p${t.priority}`, t.claim ? `${t.claim.role}@${t.claim.machine}` : null]
          .filter(Boolean)
          .join(" · "),
        ...(t.status === "done" || t.status === "rejected" ? { status: "dark" } : {}),
      });
    }
    y += h + 40;
  }
  const ids = new Set(placed.map((p) => p.task.id));
  let k = 0;
  const edges = placed.flatMap(({ task }) =>
    task.after.filter((id) => ids.has(id)).map((id) => ({ id: `e${++k}`, source: `t${id}`, target: `t${task.id}`, label: "first", style: "dashed" }))
  );
  return { version: 1, meta: { title: `${title}: task graph`, routing: "orthogonal", versionTag: new Date().toISOString().slice(0, 10) }, nodes, edges };
}
