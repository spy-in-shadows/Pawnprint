# Development log

One row per non-trivial problem (conflict, contract mismatch, failed approach, tooling issue).

| Date | Person | Prompt ID | What happened | Cause | Fix | Prototype files consulted | Minutes lost |
|---|---|---|---|---|---|---|---|
| 2026-11-10 | B | B1 | `npm install` printed `allow-scripts` warnings and skipped the install scripts of `bcrypt@6` and `@prisma/engines@5.22.0`. | npm 11 does not run dependency lifecycle scripts unless they are approved. | Checked both: `bcrypt` loads its prebuilt binary and `npx prisma -v` reports 5.22.0, so no approval is needed now. If `prisma generate` fails later, run `npm approve-scripts @prisma/engines`. Prisma is pinned to `^5.22.0` to match DESIGN.md and the prototype schema. | `package.json`, `vitest.config.js`, `.gitignore`, `DESIGN.md`, prototype conventions file (now `ENGINEERING.md`) | 5 |
| 2026-11-10 | B | B1 | First `git push` of the skeleton was rejected (non-fast-forward). | `origin/main` had a newer commit (`337cf85` "Restore project title in README") that cut README.md down to its title line. | Fetched and rebased onto `origin/main`. Resolved the README.md conflict with the 10-line B1 stub but kept the "Pawnprint —" title from the remote commit. | none | 3 |
