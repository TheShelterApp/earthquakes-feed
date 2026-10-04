#!/usr/bin/env bash
# Push the data checkout's HEAD to origin/<branch> (default `data`), fail-loud (H3): a concurrent writer's commit is
# fetched and rebased onto, up to PUSH_ATTEMPTS times (default 3); a rebase conflict aborts the rebase and fails with
# an ::error:: annotation instead of losing either side. Run from inside the data checkout, after the commit.
# Every writer workflow used to inline this loop; aggregate.yml calls this script (tests/push-data.test.ts).
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
  if [ "$backoff" -gt 0 ]; then sleep $((i * backoff)); fi
  if ! git fetch origin "$branch"; then
    echo "::error::fetching origin/${branch} failed after a rejected push (attempt ${i})"
    exit 1
  fi
  if ! git rebase "origin/${branch}"; then
    # `|| true`: with no rebase in progress --abort exits 128; the annotation below must still be printed.
    git rebase --abort || true
    echo "::error::rebase conflict pushing to ${branch}"
    exit 1
  fi
  i=$((i + 1))
done
echo "::error::push to ${branch} failed after ${attempts} attempts"
exit 1
