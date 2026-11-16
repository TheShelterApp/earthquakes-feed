#!/usr/bin/env bash
# Create the append-only `data` serving branch (orphan, empty skeleton) and push it.
# Run once, from a clean working tree, after cloning the repo.
set -euo pipefail

if git rev-parse --verify --quiet data >/dev/null; then
  echo "Branch 'data' already exists locally. Nothing to do."
  exit 0
fi

start_branch=$(git rev-parse --abbrev-ref HEAD)
echo "Creating orphan 'data' branch from a clean tree (current: $start_branch)…"

git switch --orphan data
git rm -rf . >/dev/null 2>&1 || true

# .gitignore FIRST: `git rm -rf .` just deleted the tracked one, and without it the
# `git add` below would sweep untracked node_modules/ into the branch (the H7 bug).
cat > .gitignore <<'EOF'
node_modules/
.data/
public/
.DS_Store
EOF

mkdir -p knowledge/observations knowledge/snapshots knowledge/index events status/history
printf '{"seq":0,"ingest_time":""}\n' > knowledge/index/head.json
printf '{}\n'                          > knowledge/index/watermarks.json
# An empty generation (storage phase 3, src/event-map-store.ts serializeGeneration): the explicit "no event-map day yet"
# that lets the fail-closed readers start (loadEventMap and liveFloor never read a missing event map as empty or today).
printf '{\n"format": 1,\n"head_seq": 0,\n"parent": null,\n"components": {"event_map": {"layout": "day", "node_schema": 1, "days": {\n}}}\n}\n' > knowledge/index/generation.json

cat > README.md <<'EOF'
# earthquakes-feed — `data` branch

Append-only serving branch (the historized feed). **Never force-push this branch.**
Written by GitHub Actions (`aggregate` / `derive`). Code lives on `main`.

- `knowledge/observations/…` — the append-only observation log (source of truth)
- `knowledge/index/…`        — head cursor, event_map, watermarks, generation.json (the event map's state-store blobs)
- `events/YYYY/MM/DD.ndjson` — event-time day partitions (plain NDJSON)
- `manifest.json`            — catalog copy (canonical lives on Cloudflare Pages /v1/)
EOF

git add .gitignore README.md knowledge events status
git commit -m "bootstrap: initialize data branch"
git switch "$start_branch"

echo
echo "Done. Push it with:"
echo "    git push -u origin data"
