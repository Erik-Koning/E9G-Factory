#!/usr/bin/env node
// PostToolUse, after the planner's own email to the operator: records that it went, so the guard holds the next one
// to the team's contact setting (lib/contact.ts). A send that failed isn't recorded. Inert outside a team.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { messageKind, recordSent } from "../../lib/contact.ts";
import { type HookInput, inTeam, roleFor } from "../../lib/session.ts";

if (!inTeam() || !process.env.E9G_RUN) process.exit(0);
// An MCP tool's error comes back as a result marked isError, or as text saying so.
const failed = (response: unknown): boolean =>
  (typeof response === "object" && response !== null && (response as { isError?: unknown }).isError === true) ||
  (typeof response === "string" && /^error\b/i.test(response.trim()));
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
  if (roleFor(input.agent_type) === "planner" && /__(send_message|send_email|send)$/.test(input.tool_name ?? "") && !failed(input.tool_response))
    recordSent(resolve(process.env.E9G_RUN), messageKind(String(input.tool_input?.subject ?? "")));
} catch {}
process.exit(0);
