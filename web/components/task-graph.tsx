// The task graph as SVG, from the factory's own layout (lib/tasks/graph.ts), drawn like e9g serve's: a band per
// journey (and one for tasks in none), a box per task in columns by how many tasks come first, a line per dependency.
import { layout } from "../../lib/tasks/graph.ts";
import { journeyDue, type Task } from "../../lib/tasks/model.ts";
import { clip } from "./ui.tsx";

const BOX_W = 200;
const BOX_H = 52;
const COL_W = BOX_W + 44;
const ROW_H = BOX_H + 14;
const PAD = 14;
const BAND_TOP = 34;
const BAND_GAP = 16;

export function TaskGraph({ tasks }: { tasks: Task[] }) {
  const { bands, placed } = layout(tasks);
  if (!placed.length && !bands.some((b) => b.journey)) return <p className="empty">No tasks yet.</p>;
  const where = new Map<string, { x: number; y: number }>();
  const width = Math.max(...bands.map((b) => PAD * 2 + b.cols * COL_W - (COL_W - BOX_W)));
  const drawnBands: { id: string; y: number; h: number; label: string }[] = [];
  let y = 0;
  for (const band of bands) {
    const h = BAND_TOP + band.rows * ROW_H - (ROW_H - BOX_H) + PAD;
    const label = band.journey ? `${band.label} · ${journeyDue(band.journey, tasks) ? "due its verification" : band.journey.status}` : band.label;
    drawnBands.push({ id: band.id, y, h, label });
    for (const p of placed.filter((p) => p.band === band.id)) where.set(p.task.id, { x: PAD + p.col * COL_W, y: y + BAND_TOP + p.row * ROW_H });
    y += h + BAND_GAP;
  }
  const height = Math.max(1, y - BAND_GAP);
  const lines = placed.flatMap(({ task }) =>
    task.after.flatMap((dep) => {
      const from = where.get(dep);
      const to = where.get(task.id);
      if (!from || !to) return [];
      const [x1, y1, x2, y2] = [from.x + BOX_W, from.y + BOX_H / 2, to.x, to.y + BOX_H / 2];
      return [{ key: `${dep}-${task.id}`, d: `M${x1} ${y1} C${x1 + 28} ${y1}, ${x2 - 28} ${y2}, ${x2} ${y2}` }];
    })
  );
  return (
    // Wider than a phone: it scrolls on its own, by keyboard too.
    <div className="graph" tabIndex={0} role="region" aria-label="The task graph (scrolls sideways)">
      <svg xmlns="http://www.w3.org/2000/svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="The task graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path className="arrowhead" d="M0 0 L8 4 L0 8 z" />
          </marker>
        </defs>
        {drawnBands.map((b) => (
          <g key={b.id}>
            <rect className="band" x="0.5" y={b.y + 0.5} width={width - 1} height={b.h - 1} rx="8" />
            <text className="band-label" x={PAD} y={b.y + 22}>
              {clip(b.label, 90)}
            </text>
          </g>
        ))}
        {lines.map((l) => (
          <path key={l.key} className="dep" d={l.d} markerEnd="url(#arrow)" />
        ))}
        {placed.map(({ task: t }) => {
          const at = where.get(t.id) ?? { x: 0, y: 0 };
          const detail = [
            t.status,
            t.kind,
            t.severity,
            t.priority === null ? null : `p${t.priority}`,
            t.claim ? `${t.claim.role}@${t.claim.machine}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <g key={t.id} className={`node status-${t.status}`}>
              <title>{`#${t.id} ${t.title} (${detail})`}</title>
              <rect x={at.x} y={at.y} width={BOX_W} height={BOX_H} rx="6" />
              <text x={at.x + 10} y={at.y + 21}>
                {clip(`#${t.id} ${t.title}`, 30)}
              </text>
              <text className="sub" x={at.x + 10} y={at.y + 39}>
                {clip(detail, 34)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
