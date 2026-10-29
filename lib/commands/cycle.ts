// e9g cycle close --report-file <file> | list: a cycles team's cycles (team.json mode "cycles"). Closing one records
// what was done since the last, and puts the planner's report in its outbox for the operator, where the watchdog
// sends it with the next message the team's contact setting allows.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inTeam, teamSession } from "../session.ts";
import { OPERATOR } from "../tasks/model.ts";
import { openTeamStore } from "../tasks/ops.ts";
import { parseArgs, text as optionText, writeFileAtomic } from "../util.ts";

export async function cycle(argv: string[]): Promise<number> {
  const [sub = "list", ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  const who = inTeam() ? process.env.E9G_ROLE || "unknown" : OPERATOR;
  const { home, team, run } = teamSession();
  if (team.board.type !== "tasks" || team.mode !== "cycles") {
    console.error('cycle: this team works to a finish line (team.json mode); cycles are for "mode": "cycles"');
    return 2;
  }
  const store = await openTeamStore(team, run, home);
  try {
    const cycles = await store.cycles.all();
    if (sub === "list") {
      console.info(
        cycles.length
          ? cycles.map((c) => `${c.id} ${c.at.slice(0, 16)}: ${c.done.length} done. ${c.report.split("\n")[0]}`).join("\n")
          : "no cycles closed yet"
      );
      return 0;
    }
    if (sub !== "close") {
      console.error("usage: e9g cycle close --report-file <file> | e9g cycle list");
      return 2;
    }
    if (who !== "planner" && who !== OPERATOR) {
      console.error("cycle: the planner closes a cycle");
      return 2;
    }
    const file = optionText(options["report-file"]);
    const report = (file ? readFileSync(resolve(file), "utf8") : (optionText(options["report"]) ?? positional.join(" "))).trim();
    if (report.length < 40) {
      console.error("cycle: the report says what was built and verified, the calls you made, what's next and what you assumed (--report-file)");
      return 2;
    }
    const since = cycles.at(-1)?.at ?? "";
    // Done in this cycle: moved to done since the last one closed (a later note on it doesn't count it again).
    const done = (await store.tasks.all())
      .filter((t) => t.status === "done" && t.history.some((e) => e.at > since && / → done\b/.test(e.what)))
      .map((t) => t.id);
    const closed = await store.cycles.create({ team: team.name, report, done, at: new Date().toISOString() });
    const number = closed.id.replace(/^c/, "");
    const firstLine =
      report
        .split("\n")[0]
        ?.replace(/^#+\s*/, "")
        .slice(0, 80) ?? "";
    const draft = join(run, "outbox", `${new Date().toISOString().slice(0, 10)}-cycle-${number}.md`);
    writeFileAtomic(
      draft,
      `Subject: Cycle ${number}: ${firstLine}\n\n${report}\n\nDone this cycle: ${done.map((id) => `#${id}`).join(" ") || "nothing merged"}.\n`
    );
    console.info(`cycle ${number} closed (${done.length} done); the report is in the outbox: ${draft}`);
    return 0;
  } finally {
    await store.close();
  }
}
