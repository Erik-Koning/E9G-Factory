#!/usr/bin/env node
// The CLI under its name before 0.3.0. The shared launcher (~/.e9g/bin/e9g) is written by whichever version installs
// last, and 0.2.0's, like its hand-over to a team's pinned version, runs bin/e9g.mjs. This keeps a release that's
// pinned or current reachable when an older version installs after it.
await import("./e9g.ts");
