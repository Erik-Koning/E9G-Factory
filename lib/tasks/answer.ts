// The operator's answers to what waits on them: a question the planner or the approver asked (status question), or
// blocked work raised to them. An answer is a note by the operator, marked as one, that leaves the task where it is: the
// planner reads it, records it in decisions.md and moves the task on (approving or rejecting it outright is
// decide.ts). The web app answers through here. The lead's watchdog passes each new answer to the planner
// (lib/answers.ts), so it acts on it within a minute instead of at its next wake.
import { type Actor, type Note, nowIso, OPERATOR, Refused, type Status, type Task } from "./model.ts";
import { type Store, update } from "./store.ts";

// What waits on the operator: every question, and blocked work raised to them (with an ask: a block that waits on
// other tasks, or that the planner sorts, isn't theirs); never a journey (journeys only group tasks).
export const WAITING: readonly Status[] = ["question", "blocked"];
export const waitsOnOperator = (t: Task): boolean => t.kind !== "journey" && (t.status === "question" || (t.status === "blocked" && Boolean(t.ask)));

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// The operator answers task `id`. Throws a Refused saying why when it can't: nothing said, someone other than the
// operator, or a task that no longer waits on an answer (the planner moved it on meanwhile).
export async function answer(store: Store, id: string, { who, text }: { who: Actor; text: string }): Promise<Task> {
  const said = text.trim();
  if (who !== OPERATOR) throw new Refused("only the operator answers what waits on them");
  if (!said) throw new Refused("say what your answer is");
  const task = await store.tasks.get(id.replace(/^#/, ""));
  if (!task) throw new Refused(`no task ${id}`);
  return update(store.tasks, task.id, (t) => {
    if (!waitsOnOperator(t)) throw new Refused(`#${t.id} is ${t.status} now and doesn't wait on an answer: the planner moved it on`);
    const at = nowIso();
    const note: Note = { at, by: who, text: said, kind: "answer" };
    return {
      ...t,
      notes: [...t.notes, note],
      updatedAt: at,
      history: [...t.history, { at, by: who, what: `answered: ${clip(said.replace(/\s+/g, " "), 120)}` }].slice(-200),
    };
  });
}

// When `t` last came to wait on the operator (entered its status), or its creation.
export const waitingSince = (t: Task): string => t.history.findLast((e) => e.to === t.status)?.at ?? t.createdAt;

// The operator's answers on `t` since it last came to wait on them, oldest first.
export const answersOn = (t: Task): Note[] => {
  const since = waitingSince(t);
  return t.notes.filter((n) => n.kind === "answer" && n.at >= since);
};

export interface PendingAnswer {
  task: Task;
  note: Note;
  // Unique per answer: the watchdog's marker that it went to the planner.
  key: string;
}

// The answers to pass to the planner: on tasks still waiting on the operator, given at or after `since` (ISO), oldest
// first. The watchdog leaves out those it passed on already, by key.
export function answersSince(tasks: Task[], since: string): PendingAnswer[] {
  return tasks
    .filter(waitsOnOperator)
    .flatMap((task) =>
      task.notes.filter((n) => n.kind === "answer" && n.at >= since).map((note) => ({ task, note, key: `answer-${task.id}-${Date.parse(note.at)}` }))
    )
    .sort((a, b) => a.note.at.localeCompare(b.note.at));
}

// One message to the planner for every answer that came since it last heard.
export function answersMessage(answers: PendingAnswer[]): string {
  const lines = answers.map(({ task, note }, i) => `${i + 1}. #${task.id} "${task.title}" (${task.status}): ${note.text}`);
  return [
    `The operator answered in the web app:`,
    "",
    ...lines,
    "",
    `Each answer is a note on its task already (a6g task show <id>), so don't note it again. Act on it as your rules say: add it to .a6g/decisions.md, re-check the other open questions against it, and move each task on.`,
  ].join("\n");
}
