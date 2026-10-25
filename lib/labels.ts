// What a team's planner sends beyond this Mac carries one label, so the operator can tell it apart and filter on it
// (everyone on a team posts as the operator's own accounts): the GitHub issues it opens are labelled with it, and the
// subjects of its email and WhatsApp messages start with it.
export const PLANNER_LABEL = "E9G-Planner";
export const PLANNER_TAG = `[${PLANNER_LABEL}]`;

// The labels a `gh issue create …` gives its issue (--label a,b, -l a, --label=a), or null for any other command.
// Global options before `issue` (-R owner/repo) are skipped.
export function issueCreateLabels(words: string[]): string[] | null {
  const valued = new Set([
    "-R",
    "--repo",
    "--hostname",
    "-t",
    "--title",
    "-b",
    "--body",
    "-F",
    "--body-file",
    "-a",
    "--assignee",
    "-m",
    "--milestone",
    "-p",
    "--project",
    "-T",
    "--template",
    "-l",
    "--label",
  ]);
  const positional: string[] = [];
  const labels: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    const [option = "", inline] = word.startsWith("--") ? word.split(/=(.*)/s, 2) : [word, undefined];
    if (option === "-l" || option === "--label") labels.push(...(inline ?? words[++i] ?? "").split(","));
    else if (word.startsWith("-")) {
      if (inline === undefined && valued.has(option)) i++;
    } else positional.push(word);
  }
  return positional[0] === "issue" && positional[1] === "create" ? labels.map((label) => label.trim()).filter(Boolean) : null;
}
