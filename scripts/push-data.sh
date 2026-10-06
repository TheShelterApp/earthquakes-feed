#!/usr/bin/env bash
# Push the data checkout's HEAD to origin/<branch> (default `data`), fail-loud (H3): a concurrent writer's commit is
# fetched and rebased onto, up to PUSH_ATTEMPTS times (default 3); a rebase conflict aborts the rebase and fails with
# an ::error:: annotation naming the conflicting files instead of losing either side. Run from inside the data checkout,
# after the commit. Every writer calls it (FEED-OPS-4, tests/push-data.test.ts): aggregate and its derive steps
# (.github/actions/derive-publish), backfill and archive under the writer lock, and the side-index commit jobs of
# history, first-solutions and remediate without it (each writes only its own files, so their rebase cannot conflict).
# Works in the shallow (fetch-depth 1), sparse and blobless checkouts those jobs use.
#
#   PUSH_BRANCH=data PUSH_ATTEMPTS=3 PUSH_BACKOFF_S=0 bash "$GITHUB_WORKSPACE/scripts/push-data.sh"
#
# PUSH_BACKOFF_S > 0 sleeps i * PUSH_BACKOFF_S seconds before the i-th re-fetch.
set -u
branch="${PUSH_BRANCH:-data}"
attempts="${PUSH_ATTEMPTS:-3}"
backoff="${PUSH_BACKOFF_S:-0}"
i=1
while [ "$i" -le "$attempts" ]; do
  if git push origin "HEAD:${branch}"; then
    exit 0
  fi
  if [ "$i" -eq "$attempts" ]; then break; fi
  if [ "$backoff" -gt 0 ]; then sleep $((i * backoff)); fi
  # The explicit refspec updates origin/<branch> whatever the checkout configured for the remote.
  if ! git fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"; then
    echo "::error::fetching origin/${branch} failed after a rejected push (attempt ${i})"
    exit 1
  fi
  if ! git rebase "origin/${branch}"; then
    conflicts=$(git diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')
    # `|| true`: with no rebase in progress --abort exits 128; the annotation below must still be printed.
    git rebase --abort || true
    echo "::error::rebase conflict pushing to ${branch}${conflicts:+: ${conflicts}}"
    exit 1
  fi
  i=$((i + 1))
done
echo "::error::push to ${branch} failed after ${attempts} attempts"
exit 1
