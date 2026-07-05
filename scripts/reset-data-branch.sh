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
cat > .gitignore <<'EOF'
node_modules/
.data/
public/
.DS_Store
EOF

mkdir -p knowledge/observations knowledge/snapshots knowledge/index events status/history
printf '{"seq":0,"ingest_time":""}\n' > knowledge/index/head.json
printf '{}\n'                          > knowledge/index/watermarks.json
: > knowledge/index/event_map.ndjson

cat > README.md <<'EOF'
# earthquakes-feed — `data` branch

Append-only serving branch (the historized feed). **Never force-push this branch.**
Written by GitHub Actions (`aggregate` / `derive`). Code lives on `main`.

- `knowledge/observations/…` — the append-only observation log (source of truth)
- `knowledge/index/…`        — head cursor, event_map, watermarks, backfill cursor
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
