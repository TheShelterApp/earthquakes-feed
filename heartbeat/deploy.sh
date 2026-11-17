#!/usr/bin/env bash
# Deploy the heartbeat Worker, ONLY from main (FEED-OPS-2).
#
# The Worker drives every scheduled workflow of this repository, so the code it runs must be the code on main: on
# 2026-10-01 it was deployed from an unmerged branch (pf5j/heartbeat-history) and main described a Worker that did not
# exist. This script refuses unless the checkout is exactly origin/main with no local change under heartbeat/, and tags
# the version with the commit, so `wrangler deployments list` (OLDEST first: the active one is the last entry) names the
# main commit the Worker came from.
#
# Usage, from any checkout of this repository whose HEAD is origin/main:
#   FEED_HEARTBEAT_CF_EMAIL=<the Cloudflare login's email> bash heartbeat/deploy.sh   # deploys
#   bash heartbeat/deploy.sh --dry-run  # builds and checks, uploads nothing, needs no login
# A real deploy refuses unless `wrangler whoami` names FEED_HEARTBEAT_CF_EMAIL (as state/deploy.sh does): a wrangler
# logged in to another account would otherwise create a second heartbeat there, and two heartbeats dispatch every
# workflow twice (the dispatch ledger is per account). Wrangler reads its login from its usual place; a profile kept
# elsewhere is selected by the caller's environment (for example XDG_CONFIG_HOME), which this script passes through.
set -euo pipefail

die() { echo "heartbeat/deploy.sh: $*" >&2; exit 1; }

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
git fetch --quiet origin main || die "cannot fetch origin/main"
head="$(git rev-parse HEAD)"
main="$(git rev-parse origin/main)"
[ "$head" = "$main" ] || die "HEAD $(git rev-parse --short=10 HEAD) is not origin/main $(git rev-parse --short=10 origin/main): deploy only from main"
[ -z "$(git status --porcelain -- .)" ] || die "heartbeat/ has local changes: deploy only what main holds"

wrangler="$here/../node_modules/.bin/wrangler"
[ -x "$wrangler" ] || die "wrangler not installed: run npm ci at the repository root"

msg="main $(git rev-parse --short=10 HEAD)"
if [ "${1:-}" = "--dry-run" ]; then
  exec "$wrangler" deploy --dry-run
fi
[ $# -eq 0 ] || die "unknown argument: $1 (usage: bash heartbeat/deploy.sh [--dry-run])"

[ -n "${FEED_HEARTBEAT_CF_EMAIL:-}" ] || die "set FEED_HEARTBEAT_CF_EMAIL to the email of the Cloudflare account that owns the Worker"
who="$("$wrangler" whoami 2>&1)" || die "wrangler whoami failed: log in first (wrangler login)"
grep -qiF -- "$FEED_HEARTBEAT_CF_EMAIL" <<<"$who" || die "wrangler is not logged in as $FEED_HEARTBEAT_CF_EMAIL: check the profile (wrangler whoami)"

echo "heartbeat/deploy.sh: deploying from $msg"
exec "$wrangler" deploy --message "$msg"
