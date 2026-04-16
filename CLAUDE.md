# OpStream — Claude Code Instructions

## Git workflow

MUST follow for all code changes:

1. **Always branch from `main`** before making changes:
   - `feat/...` — new feature (small or large)
   - `fix/...` — bug fix
   - `chore/...` — tooling, deps, docs, config
   - `refactor/...` — internal restructure with no behaviour change
2. **Make focused commits** on the branch. Multiple commits per branch is fine and encouraged.
3. **Open a PR** using the PR template. Always add one semver label:
   - `semver:major` — breaking change or major milestone (bumps X.y.z)
   - `semver:minor` — meaningful improvement or significant new capability (bumps x.Y.z)
   - `semver:patch` — small feature, small fix, chore, refactor, docs (bumps x.y.Z)
4. **Never commit directly to `main`** unless the user explicitly says so in the message.

Semver guide for this project:
- **Z (patch)** — the default. Small features, small fixes, docs, chores, any general commit.
- **Y (minor)** — a meaningful new capability or consequent improvement. Use judgment.
- **X (major)** — breaking API/schema change or major product milestone.

## Tech stack

- **Node.js 24** — not 22. CI enforces this.
- **better-sqlite3** — synchronous SQLite driver. Not async `sqlite3` or `better-sqlite3-multiple-ciphers`.
- **TypeScript strict** — `npx tsc --noEmit` must pass before any commit.
- **ESLint** — `npx eslint src tests` must pass with zero errors.
- **Vitest** — all new behaviour needs tests. Run `npm test` before declaring work done.

## Database conventions

- Both SQLite (default) and Postgres are supported via the `DbAdapter` interface.
- Schema lives in `src/core/db.ts`. Postgres schema lives in `src/core/postgresAdapter.ts`.
- **Migrations**: always check column existence before `ALTER TABLE`. Use `PRAGMA table_info(table)` for SQLite.
- `storeGenericTxs` defaults to `false` — non-OPNET Bitcoin txs are ~95% of block data and nothing queries them. Don't change this default.

## Known test state

- `rpcServer.test.ts` has 16 pre-existing failures (paginated `opstream_getLogs` response shape mismatch). These are known tech debt — do not treat them as regressions from new work, and do not fix them unless explicitly asked.

## Commit messages

Follow the existing style: `type(scope): short description`
- `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
- Keep the subject line under 72 characters.
