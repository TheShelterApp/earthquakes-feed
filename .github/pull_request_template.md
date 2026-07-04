## What & why

<!-- Brief description. Link any related issue. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] If adding a provider: `providers/registry.json` has real `license` + `attribution`, and `node scripts/gen-attributions.mjs` was run
- [ ] Adapters are fail-open (a source error loses no existing data)
- [ ] No `Date.now()` inside dedup/identity resolution (determinism)
- [ ] Data contract changes are additive / version-bumped (see GOVERNANCE.md)
