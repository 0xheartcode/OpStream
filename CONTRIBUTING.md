# Contributing to OpStream

Thanks for looking at OpStream. This document covers how to get a working dev
environment and what we expect in a pull request.

---

## Prerequisites

- **Node.js >= 22** (matches the `engines` field in `package.json`)
- **npm** (comes with Node)
- **just** (optional — wraps common commands; install from https://github.com/casey/just)

---

## Getting started

```bash
git clone https://github.com/opnet-collective/opstream.git
cd opstream
npm install
cp .env.example .env   # fill in RPC_URL at minimum
```

---

## Running the checks

All three checks must pass before you open a PR:

```bash
# With just:
just check

# Without just:
npx tsc --noEmit
npx eslint src tests
npx vitest run
```

CI runs the same three commands on every push and PR — no exceptions.

---

## Project layout

```
src/
  core/          DB adapters (SQLite, Postgres), logger, schema
  indexer/       Scanner, live indexer, event store, webhooks
  rpc/           OPNET RPC client
  readers/       Pool and token readers (opnet SDK calls)
tests/           Vitest test files — one per module
docs/            Usage guides (configuration, websocket, webhooks, querying, op-index)
```

---

## What we accept

- Bug fixes with a failing test that becomes passing
- Performance improvements with a measurable justification
- New event fields or DB columns — must be backwards-compatible (nullable or with default)
- Documentation fixes — always welcome, no test needed

## What we do not accept

- Breaking changes to the `WebhookEvent` shape or the DB schema without a migration path
- New runtime dependencies without prior discussion in an issue
- Features that belong in op-index (application-level indexing) rather than OpStream (raw infrastructure)

---

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: short description
fix: short description
refactor: short description
docs: short description
test: short description
```

Keep the subject line under 72 characters. Use the body for the "why" when it
isn't obvious from the diff.

---

## Tests

- Tests live in `tests/` alongside the source they cover.
- New public functions need at least one test covering the happy path and one covering failure/fallback.
- Tests use Vitest with real in-memory SQLite where DB access is needed. No mocking the database.
- External SDK calls (`getContract`, `provider.*`) are mocked via `vi.mock`.

---

## Opening a PR

1. Fork the repo and create a branch from `main`.
2. Make your changes, run `just check` (or the three commands above).
3. Open a PR — the template will prompt you for the required checklist.
4. CI will run automatically. Green CI is required before merge.

---

## Questions

Open an issue with the `question` label or start a GitHub Discussion.
