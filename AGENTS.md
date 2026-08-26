# Storyhold / Smart-Memory fork — operating rules

## Publishing and installation boundary

- **Bobby uploads/publishes to GitHub only. Badi installs and tests on the Mac.** Do not install, update, or modify the Mac's SillyTavern instance unless Badi explicitly authorizes that specific action.
- **Never rewrite published Git history** on this repo (no force-push, filter-branch, or rebase-and-push) once any commit has been pulled by an installed copy. Rewriting breaks every installed copy's updater with "divergent branches". For authorship or identity corrections, add a new commit; do not rewrite history.

## GitHub identity lane

- This repo ships under **cspiritsong** (`cspiritsong <cspiritsong@users.noreply.github.com>`). Do not commit or push as `badiyee85`. Push with the `GITHUB_CSPIRITSONG_TOKEN` credential; never let the active `badiyee85` credential push to this repo.

## Verification

- Run `npm test` (and the lint/syntax/package gate) before reporting any change as done. Report real command output, not a description of expected output.
