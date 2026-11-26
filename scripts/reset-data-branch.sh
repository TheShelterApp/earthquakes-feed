#!/usr/bin/env bash
# ONE-TIME DESTRUCTIVE RESET of the `data` branch: wipe all previously collected
# (old-format) data and force-push a fresh, empty new-format-ready skeleton, so the
# feed re-collects from scratch under the superset field model.
#
# This deliberately breaks the "never force-push data" rule for a single planned reset.
# PAUSE all writers first (heartbeat Worker + scheduled workflows) — see RESET runbook —
# or a mid-flight run will race the force-push and re-seed old-format data.
#
# Usage:  scripts/reset-data-branch.sh --yes
set -euo pipefail

if [[ "${1:-}" != "--yes" ]]; then
  echo "Refusing: this FORCE-PUSHES origin/data and destroys all collected history."
  echo "Pause writers first (heartbeat + workflows), then re-run with --yes."
  exit 1
fi

remote="${RESET_REMOTE:-origin}"
start_branch=$(git rev-parse --abbrev-ref HEAD)
echo "Resetting '$remote/data' (current branch: $start_branch)…"

# Fresh orphan — no old blobs carried over.
git branch -D data 2>/dev/null || true
git switch --orphan data
git rm -rf . >/dev/null 2>&1 || true

# .gitignore FIRST so `git add` can't sweep untracked node_modules/ into the branch.
# The last three lines are storage phase 3b's (src/event-map-store.ts IGNORE_LINES): the event map's day files live in
# the state store and are never tracked; only the two sentinels below are.
cat > .gitignore <<'EOF'
node_modules/
.data/
public/
.DS_Store
knowledge/index/event_map/*
!knowledge/index/event_map/0000-00-00.ndjson
!knowledge/index/event_map/9999-12-31.ndjson
EOF

mkdir -p knowledge/observations knowledge/snapshots knowledge/index/event_map events status/history
printf '{"seq":0,"ingest_time":""}\n' > knowledge/index/head.json
printf '{}\n'                          > knowledge/index/watermarks.json
# An empty generation (storage phase 3, src/event-map-store.ts serializeGeneration): the explicit "no event-map day yet"
# that lets the fail-closed readers start (loadEventMap and liveFloor never read a missing event map as empty or today).
printf '{\n"format": 1,\n"head_seq": 0,\n"parent": null,\n"components": {"event_map": {"layout": "day", "node_schema": 1, "days": {\n}}}\n}\n' > knowledge/index/generation.json
# The phase-3b sentinels (src/event-map-store.ts SENTINEL_FILES, SENTINEL_TEXT): the only tracked paths under
# knowledge/index/event_map/, not JSON on purpose, so code from before storage phase 3 fails on them instead of reading
# an untracked event map as empty (9999-12-31: its loader; 0000-00-00: its live floor, so an old backfill writes nothing).
for s in 0000-00-00 9999-12-31; do
  printf '%s\n' 'phase 3b sentinel: the event map lives in the state store (knowledge/index/generation.json); this line is not JSON on purpose' > "knowledge/index/event_map/$s.ndjson"
done

cat > README.md <<'EOF'
# earthquakes-feed — `data` branch

Append-only serving branch (the historized feed). **Never force-push this branch.**
Written by GitHub Actions (`aggregate` / `derive`). Code lives on `main`.

- `knowledge/observations/…` — the append-only observation log (source of truth)
- `knowledge/index/…`        — head cursor, watermarks, backfill cursor, generation.json (the event map's days in the state store; git holds only its sentinels)
- `events/YYYY/MM/DD.ndjson` — event-time day partitions (plain NDJSON)
- `manifest.json`            — catalog copy (canonical lives on Cloudflare Pages /v1/)
EOF

git add .gitignore README.md knowledge events status
git commit -m "reset: reinitialize data branch for superset field model"
git push --force "$remote" data

git switch "$start_branch"
echo
echo "Done. origin/data reset to an empty new-format skeleton."
echo "Now: delete archive-* Releases, then re-enable the heartbeat + workflows."
