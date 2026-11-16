#!/usr/bin/env bash
# Deploy the state Worker, ONLY from main (state/README.md "Deploy"). Mirrors heartbeat/deploy.sh (FEED-OPS-2).
#
# The 5-minute aggregate run reads and writes the event map through this Worker, so the code it runs must be the code
# on main. The script refuses unless the checkout is the branch main, exactly at origin/main, with a clean working tree
# (no change and no untracked file anywhere), and unless `wrangler whoami` names the Cloudflare account the caller
# expects. It tags the version with the commit, so `wrangler deployments list` (OLDEST first: the active one is the
# last entry) names the main commit the Worker came from.
#
# Usage, from a checkout of this repository on main at origin/main, after `npm ci` at the repository root:
#   FEED_STATE_CF_EMAIL=<the Cloudflare login's email> bash state/deploy.sh                # production
#   FEED_STATE_CF_EMAIL=<the Cloudflare login's email> bash state/deploy.sh --env staging  # staging
#   bash state/deploy.sh [--env staging] --dry-run   # bundles and checks, uploads nothing, needs no login
# Wrangler reads its login from its usual place; a profile kept elsewhere is selected by the caller's environment (for
# example XDG_CONFIG_HOME), which this script passes through untouched.
set -euo pipefail

die() { echo "state/deploy.sh: $*" >&2; exit 1; }

target=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      [ $# -ge 2 ] || die "--env needs a value (staging or production)"
      target="$2"
      shift 2
      ;;
    --env=*)
      target="${1#--env=}"
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    *) die "unknown argument: $1 (usage: bash state/deploy.sh [--env staging] [--dry-run])" ;;
  esac
done
case "$target" in
  "" | production)
    # The top level of wrangler.toml is production; --env "" selects it explicitly.
    env_flag=""
    label="production"
    host="feed-state.theshelter.app"
    ;;
  staging)
    env_flag="staging"
    label="staging"
    host="feed-state-staging.theshelter.app"
    ;;
  *) die "unknown environment: $target (staging or production)" ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
cd "$here"
git fetch --quiet origin main || die "cannot fetch origin/main"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
[ "$branch" = "main" ] || die "the checkout is on ${branch:-a detached HEAD}, not main: deploy only from main"
head="$(git rev-parse HEAD)"
main="$(git rev-parse origin/main)"
[ "$head" = "$main" ] || die "HEAD $(git rev-parse --short=10 HEAD) is not origin/main $(git rev-parse --short=10 origin/main): deploy only from main"
[ -z "$(git status --porcelain)" ] || die "the working tree is not clean (git status): deploy only what main holds"

wrangler="$here/../node_modules/.bin/wrangler"
[ -x "$wrangler" ] || die "wrangler not installed: run npm ci at the repository root"

if [ "$dry_run" = 1 ]; then
  exec "$wrangler" deploy -c wrangler.toml --env "$env_flag" --dry-run
fi

[ -n "${FEED_STATE_CF_EMAIL:-}" ] || die "set FEED_STATE_CF_EMAIL to the email of the Cloudflare account that owns the Worker"
who="$("$wrangler" whoami 2>&1)" || die "wrangler whoami failed: log in first (wrangler login)"
grep -qiF -- "$FEED_STATE_CF_EMAIL" <<<"$who" || die "wrangler is not logged in as $FEED_STATE_CF_EMAIL: check the profile (wrangler whoami)"

msg="main $(git rev-parse --short=10 HEAD)"
echo "state/deploy.sh: deploying $label ($host) from $msg"
"$wrangler" deploy -c wrangler.toml --env "$env_flag" --message "$msg"
echo "state/deploy.sh: deployed $label from $msg. Verify (state/README.md \"Verify\"): an unauthenticated call must answer 401 from the Worker:"
echo "  curl -sS -o /dev/null -w '%{http_code}\\n' -X POST https://$host/v1/cas:batchGet"
