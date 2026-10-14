#!/usr/bin/env bash
# Deploy the built site (public/) to Cloudflare Pages by Direct Upload, the last step of every aggregate run
# (.github/actions/derive-publish; tests/pages-deploy.test.ts). Retrying is safe: assets are content-addressed, and
# Direct Upload deploys have not counted against the 500-builds/month Pages cap (about 8,600 a month so far; Cloudflare's
# limits page describes that cap for builds from Git pushes).
#
# Failures seen: control-plane errors after a finished upload (2026-07-12 'malformed response from the API'; runs
# 29588370032, 30256024198 and 38254416999 on 2026-10-12, 'Failed to publish your Function'), and an asset upload that
# hung for minutes and then answered HTTP 500 (run 38112591591, 2026-10-11): that one held the job until its 16-minute
# timeout, so the run was cancelled with no clear outcome. Hence:
# - each attempt is capped (timeout -k 10 420: TERM after 7 min, KILL 10 s later), and never past the job's own budget;
# - a retry starts only while at least PAGES_MIN_LEFT_S (7 min) of the job's budget is left after the pause;
# - after the last failed attempt the LIVE manifest decides: under PAGES_FRESH_S (15 min) old, the feed is still
#   inside its 30-minute freshness contract and the next aggregate run (every 5 min) deploys again, so the step warns
#   and exits 0; older, or unreadable, it fails. health.yml's freshness check of the live manifest stays the alarm.
#
# The job's budget: JOB_STARTED_S (epoch seconds, noted by the workflow's first step) + JOB_TIMEOUT_MIN (the job's
# timeout-minutes). Either one blank: attempts are capped at PAGES_ATTEMPT_TIMEOUT_S only, and every attempt runs.
#
#   JOB_STARTED_S=... JOB_TIMEOUT_MIN=16 bash "$GITHUB_WORKSPACE/scripts/pages-deploy.sh"
#
# Knobs (the defaults are the production values; tests shrink them): PAGES_DIR (public), PAGES_ATTEMPTS (3),
# PAGES_ATTEMPT_TIMEOUT_S (420), PAGES_KILL_AFTER_S (10), PAGES_RETRY_PAUSE_S (20), PAGES_MIN_LEFT_S (420),
# PAGES_RESERVE_S (60: the manifest check and the job's post steps), PAGES_FRESH_S (900), PAGES_LIVE_MANIFEST_URL.
set -u
dir="${PAGES_DIR:-public}"
attempts="${PAGES_ATTEMPTS:-3}"
cap="${PAGES_ATTEMPT_TIMEOUT_S:-420}"
kill_after="${PAGES_KILL_AFTER_S:-10}"
pause="${PAGES_RETRY_PAUSE_S:-20}"
min_left="${PAGES_MIN_LEFT_S:-420}"
reserve="${PAGES_RESERVE_S:-60}"
fresh="${PAGES_FRESH_S:-900}"
url="${PAGES_LIVE_MANIFEST_URL:-https://earthquakes-feed.theshelter.app/v1/manifest.json}"

now() { date -u +%s; }
is_int() { case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac; }

deadline=''
if is_int "${JOB_STARTED_S:-}" && is_int "${JOB_TIMEOUT_MIN:-}"; then
  deadline=$((JOB_STARTED_S + JOB_TIMEOUT_MIN * 60))
else
  echo "the job's budget is unknown (JOB_STARTED_S='${JOB_STARTED_S:-}', JOB_TIMEOUT_MIN='${JOB_TIMEOUT_MIN:-}'): each attempt capped at ${cap}s, no budget check"
fi

tried=0
i=1
while [ "$i" -le "$attempts" ]; do
  limit="$cap"
  if [ -n "$deadline" ]; then
    room=$((deadline - $(now) - reserve - kill_after))
    if [ "$room" -lt 30 ]; then
      echo "::warning::no time left in the job's budget for Pages deploy attempt ${i} ($((deadline - $(now)))s left)"
      break
    fi
    if [ "$room" -lt "$limit" ]; then limit="$room"; fi
  fi
  echo "Pages deploy attempt ${i} of ${attempts} (capped at ${limit}s)"
  tried=$i
  timeout -k "$kill_after" "$limit" npx --no-install wrangler pages deploy "$dir" --project-name=earthquakes-feed --branch=main --commit-dirty=true
  rc=$?
  if [ "$rc" -eq 0 ]; then exit 0; fi
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "::warning::Pages deploy attempt ${i} stopped after its ${limit}s cap (exit ${rc})"
  else
    echo "::warning::Pages deploy attempt ${i} failed (exit ${rc})"
  fi
  if [ "$i" -ge "$attempts" ]; then break; fi
  if [ -n "$deadline" ]; then
    left=$((deadline - $(now) - pause))
    if [ "$left" -lt "$min_left" ]; then
      echo "not retrying: ${left}s of the job's budget would be left after the pause, under ${min_left}s"
      break
    fi
  fi
  sleep "$pause"
  i=$((i + 1))
done

# Every attempt failed (or none could run): is the live feed still fresh?
what="Cloudflare Pages deploy failed after ${tried} attempt(s)"
if [ "$tried" -eq 0 ]; then what="Cloudflare Pages deploy not attempted (no time left in the job's budget)"; fi
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
age=''
if curl -sf --retry-all-errors --retry 1 --retry-delay 3 --max-time 20 "$url" -o "$tmp"; then
  age=$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (typeof m.generated !== "number" || !Number.isFinite(m.generated)) process.exit(1);
    process.stdout.write(String(Math.round((Date.now() - m.generated) / 1000)));
  ' "$tmp") || age=''
fi
if [ -z "$age" ]; then
  echo "::error::${what}, and the live manifest could not be read (${url})"
  exit 1
fi
if [ "$age" -lt "$fresh" ]; then
  echo "::warning::${what}; the live manifest is ${age}s old (under ${fresh}s), so this run stays green: the next aggregate run deploys again, and health.yml's freshness check of the live manifest is the alarm"
  exit 0
fi
echo "::error::${what}, and the live manifest is ${age}s old (${fresh}s or more)"
exit 1
