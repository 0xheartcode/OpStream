## Summary

<!-- What does this PR change and why? 1–3 sentences. -->

## Type

- [ ] `feat` — new feature (small or large)
- [ ] `fix` — bug fix
- [ ] `chore` — tooling, deps, docs, config
- [ ] `refactor` — internal restructure, no behaviour change

## Semver label

Add **one** of the following labels to this PR before merging:

| Label | Bumps | When to use |
|---|---|---|
| `semver:patch` | x.y.**Z** | Small feature, fix, chore, docs — the default |
| `semver:minor` | x.**Y**.z | Meaningful new capability or consequent improvement |
| `semver:major` | **X**.y.z | Breaking API/schema change or major milestone |

## Checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `npx eslint src tests` passes with zero errors
- [ ] `npm test` — all tests green, new behaviour has tests
- [ ] `CHANGELOG.md` entry is not needed — the release workflow appends it automatically on merge
- [ ] Docs updated if a public RPC method or config variable changed (`docs/rpc.md`)
