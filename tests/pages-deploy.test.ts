import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// FEED-TEST-1 style: the Pages deploy step (scripts/pages-deploy.sh, run by .github/actions/derive-publish at the end
// of every aggregate run) against a stub `npx` that plays a list of outcomes, with the live manifest read from a
// file: URL. Why (a week of red runs, swept on 2026-10-13): an upload that hung on 2026-10-11 held the job until its
// 16-minute timeout (run 38112591591, cancelled), and a Cloudflare control-plane error on 10-12 turned a run red while
// the live feed stayed inside its 30-minute contract (run 38254416999). Then the wiring: the job budget the workflows
// pass, the R2 step that can no longer skip the deploy, and the push settings.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'pages-deploy.sh');
const hasTimeout = spawnSync('sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;

/** A temporary directory with stub executables first on PATH. */
function setup(plan: string[]): { dir: string; env: NodeJS.ProcessEnv; calls: () => string[]; manifest: (ageS: number | null) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'pages-deploy-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'plan'), plan.join('\n') + '\n');
  // The stand-in for `npx --no-install wrangler pages deploy …`: logs its arguments, plays the next outcome.
  writeFileSync(
    join(bin, 'npx'),
    `#!/usr/bin/env bash
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
echo "$*" >> "$STUB_DIR/calls"
case "$(sed -n "\${n}p" "$STUB_DIR/plan")" in
  ok) echo 'Deployment complete!'; exit 0 ;;
  hang) exec sleep 30 ;;
  *) echo 'Failed to publish your Function. Got error: Unknown internal error occurred.' >&2; exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  if (!hasTimeout) {
    // macOS has no GNU timeout; the runner (Ubuntu) does, and CI tests the real one. Same contract: 124 on expiry.
    writeFileSync(
      join(bin, 'timeout'),
      `#!/usr/bin/env bash
if [ "$1" = -k ]; then shift 2; fi
d=$1; shift
mark=$(mktemp -u)
"$@" &
pid=$!
( sleep "$d"; : > "$mark"; kill -TERM "$pid" ) >/dev/null 2>&1 &
w=$!
wait "$pid"; rc=$?
if [ -e "$mark" ]; then rm -f "$mark"; exit 124; fi
kill "$w" 2>/dev/null
exit "$rc"
`,
      { mode: 0o755 },
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    STUB_DIR: dir,
    PAGES_RETRY_PAUSE_S: '0',
    PAGES_LIVE_MANIFEST_URL: `file://${join(dir, 'live.json')}`,
    JOB_STARTED_S: '',
    JOB_TIMEOUT_MIN: '',
  };
  return {
    dir,
    env,
    calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []),
    // The live manifest as Pages serves it: `generated` in epoch ms (src/derive.ts); null = no such field.
    manifest: (ageS) => {
      const body = ageS === null ? { head_seq: 1 } : { generated: Date.now() - ageS * 1000, head_seq: 1 };
      writeFileSync(join(dir, 'live.json'), JSON.stringify(body));
      return join(dir, 'live.json');
    },
  };
}

const run = (env: NodeJS.ProcessEnv, extra: Record<string, string> = {}) =>
  spawnSync('bash', [SCRIPT], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 });
const nowS = (): number => Math.floor(Date.now() / 1000);
const cap = (out: string, attempt: number): number => Number(new RegExp(`attempt ${attempt} of \\d+ \\(capped at (-?\\d+)s\\)`).exec(out)?.[1]);

test('pages-deploy: a first-try deploy runs wrangler once with the production arguments', () => {
  const s = setup(['ok']);
  const r = run(s.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(s.calls(), ['--no-install wrangler pages deploy public --project-name=earthquakes-feed --branch=main --commit-dirty=true']);
  assert.equal(cap(r.stdout, 1), 420, 'each attempt is capped at 7 min');
  assert.doesNotMatch(r.stdout, /::(warning|error)::/);
});

test('pages-deploy: failed attempts are retried, up to three', () => {
  const s = setup(['fail', 'fail', 'ok']);
  const r = run(s.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 3);
  assert.equal((r.stdout.match(/::warning::Pages deploy attempt \d failed \(exit 1\)/g) ?? []).length, 2);
});

test('pages-deploy: every attempt failed, live manifest under 15 min old → a warning and exit 0', () => {
  const s = setup(['fail', 'fail', 'fail', 'ok']);
  s.manifest(8 * 60);
  const r = run(s.env);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 3, 'three attempts, no fourth');
  assert.match(r.stdout, /::warning::Cloudflare Pages deploy failed after 3 attempt\(s\); the live manifest is 4[78]\ds old \(under 900s\)/);
  assert.doesNotMatch(r.stdout, /::error::/);
});

test('pages-deploy: every attempt failed, live manifest 15 min old or more → an error and exit 1', () => {
  const s = setup(['fail', 'fail', 'fail']);
  s.manifest(20 * 60);
  const r = run(s.env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error::Cloudflare Pages deploy failed after 3 attempt\(s\), and the live manifest is 1[12]\d\ds old \(900s or more\)/);
});

test('pages-deploy: every attempt failed and the live manifest is unreadable or has no `generated` → exit 1', () => {
  const missing = setup(['fail', 'fail', 'fail']);
  const r1 = run(missing.env);
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /::error::Cloudflare Pages deploy failed after 3 attempt\(s\), and the live manifest could not be read/);
  const odd = setup(['fail', 'fail', 'fail']);
  odd.manifest(null);
  const r2 = run(odd.env);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /the live manifest could not be read/);
});

test('pages-deploy: a hung attempt is stopped at its cap and the next one deploys', () => {
  const s = setup(['hang', 'ok']);
  const t0 = Date.now();
  // 2 s, not 1: the cap also bounds the second attempt, whose stub must start in time on a loaded machine.
  const r = run(s.env, { PAGES_ATTEMPT_TIMEOUT_S: '2', PAGES_KILL_AFTER_S: '1' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Date.now() - t0 < 15_000, 'the 30 s hang was cut short');
  assert.equal(s.calls().length, 2);
  assert.match(r.stdout, /::warning::Pages deploy attempt 1 stopped after its 2s cap \(exit 1(24|37)\)/);
});

test('pages-deploy: with 16 min of budget from now, all three attempts run at the full cap', () => {
  const s = setup(['fail', 'fail', 'ok']);
  const r = run(s.env, { JOB_STARTED_S: String(nowS()), JOB_TIMEOUT_MIN: '16' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 3);
  for (const a of [1, 2, 3]) assert.equal(cap(r.stdout, a), 420);
});

test('pages-deploy: under 7 min of the job left after a failure → no retry; the attempt was capped inside the budget', () => {
  const s = setup(['fail', 'ok']);
  s.manifest(60);
  // 400 s of the 16 minutes left: the first attempt may use 400 - 60 (reserve) - 10 (kill grace) = 330 s.
  const r = run(s.env, { JOB_STARTED_S: String(nowS() - (16 * 60 - 400)), JOB_TIMEOUT_MIN: '16' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 1, 'no second attempt');
  const c = cap(r.stdout, 1);
  assert.ok(c >= 327 && c <= 330, `cap ${c}`);
  assert.match(r.stdout, /not retrying: \d+s of the job's budget would be left after the pause, under 420s/);
  assert.match(r.stdout, /::warning::Cloudflare Pages deploy failed after 1 attempt\(s\); the live manifest is/);
});

test('pages-deploy: the pause counts against the budget before a retry', () => {
  const s = setup(['fail', 'ok']);
  s.manifest(60);
  // 500 s left: a retry after a 100 s pause would start with 400 s, under 7 min.
  const r = run(s.env, { JOB_STARTED_S: String(nowS() - (16 * 60 - 500)), JOB_TIMEOUT_MIN: '16', PAGES_RETRY_PAUSE_S: '100' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 1);
  assert.match(r.stdout, /not retrying/);
});

test('pages-deploy: no time left for any attempt → none runs, and the live manifest decides', () => {
  const fresh = setup(['ok']);
  fresh.manifest(60);
  const r1 = run(fresh.env, { JOB_STARTED_S: String(nowS() - 16 * 60 + 60), JOB_TIMEOUT_MIN: '16' });
  assert.equal(r1.status, 0, r1.stdout + r1.stderr);
  assert.deepEqual(fresh.calls(), []);
  assert.match(r1.stdout, /::warning::no time left in the job's budget for Pages deploy attempt 1/);
  assert.match(r1.stdout, /::warning::Cloudflare Pages deploy not attempted \(no time left in the job's budget\); the live manifest is/);
  const stale = setup(['ok']);
  stale.manifest(30 * 60);
  const r2 = run(stale.env, { JOB_STARTED_S: String(nowS() - 16 * 60 + 60), JOB_TIMEOUT_MIN: '16' });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /::error::Cloudflare Pages deploy not attempted/);
});

test('pages-deploy: an unknown budget (blank or not a number) caps attempts and skips the budget check', () => {
  const s = setup(['fail', 'fail', 'ok']);
  const r = run(s.env, { JOB_STARTED_S: 'soon', JOB_TIMEOUT_MIN: '16' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls().length, 3);
  assert.match(r.stdout, /the job's budget is unknown/);
});

// ---- The wiring (.github/actions/derive-publish/action.yml, aggregate.yml, derive.yml) ----

const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const ACTION = '.github/actions/derive-publish/action.yml';

/** The composite steps of the action, by name, each with its text (comments included) and its `run` script. */
function actionSteps(): Array<{ name: string; text: string; run: string }> {
  const yml = read(ACTION);
  const body = yml.slice(yml.indexOf('\n  steps:\n'));
  return body.split(/\n    - name: /).slice(1).map((chunk) => {
    const name = chunk.split('\n')[0]!.trim();
    let run = '';
    const block = /\n      run: \|\n((?: {8}.*\n?| *\n)+)/.exec(chunk + '\n');
    if (block) run = block[1]!.split('\n').map((l) => l.slice(8)).join('\n');
    else run = /\n      run: (.+)/.exec(chunk)?.[1] ?? '';
    return { name, text: chunk, run };
  });
}

for (const [file, job] of [['.github/workflows/aggregate.yml', 'aggregate'], ['.github/workflows/derive.yml', 'derive']] as const) {
  test(`pages-deploy wiring: ${file} passes its own timeout-minutes and the start its first step notes`, () => {
    const yml = read(file);
    const timeout = /\n {4}timeout-minutes: (\d+)\n/.exec(yml)?.[1];
    assert.ok(timeout, `${file}: no job timeout-minutes`);
    assert.equal((yml.match(/\n {4}timeout-minutes: /g) ?? []).length, 1, `${file}: one job`);
    assert.equal(/\n {10}job-timeout-minutes: (\d+)\n/.exec(yml)?.[1], timeout, `${file}: job-timeout-minutes must equal the ${job} job's timeout-minutes`);
    assert.match(yml, /\n {10}job-started-at: \$\{\{ env\.FEED_JOB_STARTED_S \}\}\n/);
    const steps = yml.slice(yml.indexOf('\n    steps:\n'));
    const first = /\n {6}- (.*)\n/.exec(steps)?.[1] ?? '';
    assert.equal(first, "name: Note the job's start", `${file}: the job's start is noted by its first step`);
    assert.match(steps, /run: echo "FEED_JOB_STARTED_S=\$\(date -u \+%s\)" >> "\$GITHUB_ENV"/);
  });
}

test('pages-deploy wiring: the Pages step runs the script with the job budget; R2 before it, its failure after it', () => {
  const steps = actionSteps();
  const names = steps.map((s) => s.name);
  const r2 = names.indexOf('Publish artifacts to R2 (data origin, S3 API)');
  const pages = names.indexOf('Publish live feed to Cloudflare Pages (Direct Upload)');
  const r2fail = names.indexOf('Fail on an R2 publish error');
  assert.ok(r2 >= 0 && pages > r2 && r2fail > pages, names.join(' | '));
  assert.equal(r2fail, names.length - 1, 'the R2 failure is the last step');
  const p = steps[pages]!;
  assert.equal(p.run.trim(), 'bash "$GITHUB_WORKSPACE/scripts/pages-deploy.sh"');
  assert.match(p.text, /JOB_STARTED_S: \$\{\{ inputs\.job-started-at \}\}/);
  assert.match(p.text, /JOB_TIMEOUT_MIN: \$\{\{ inputs\.job-timeout-minutes \}\}/);
  assert.match(steps[r2]!.text, /\n {6}id: r2\n/);
  assert.match(steps[r2fail]!.text, /\n {6}if: steps\.r2\.outputs\.failed == '1'\n/);
  for (const s of steps) assert.doesNotMatch(s.text, /continue-on-error/, `${s.name}: the steps stay plain`);
});

test('pages-deploy wiring: the R2 step itself never fails; an R2 error only sets its `failed` output', () => {
  const step = actionSteps().find((s) => s.name.startsWith('Publish artifacts to R2'))!;
  const dir = mkdtempSync(join(tmpdir(), 'r2-step-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'step.sh'), step.run);
  for (const [exit, failed] of [[1, 'failed=1\n'], [0, '']] as const) {
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\necho "npx $*"\nexit ${exit}\n`, { mode: 0o755 });
    const out = join(dir, `output-${exit}`);
    writeFileSync(out, '');
    // The runner's shell for a composite `shell: bash` step.
    const r = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(dir, 'step.sh')], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, GITHUB_OUTPUT: out },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /npx --no-install tsx src\/publish-r2\.ts/);
    assert.equal(readFileSync(out, 'utf8'), failed);
    if (exit) assert.match(r.stdout, /::error::R2 publish failed; the Pages deploy runs anyway/);
  }
});

test('push settings: aggregate and derive-publish push with 5 attempts and a 5 s backoff', () => {
  const agg = read('.github/workflows/aggregate.yml');
  const push = agg.slice(agg.indexOf('- name: Commit & push observation log'), agg.indexOf('- name: Derive and publish'));
  assert.match(push, /\n {10}PUSH_ATTEMPTS=5 PUSH_BACKOFF_S=5 bash "\$GITHUB_WORKSPACE\/scripts\/push-data\.sh"\n/);
  const commit = actionSteps().find((s) => s.name === 'Commit & push derived views')!;
  assert.match(commit.text, /\n {8}PUSH_ATTEMPTS: '5'\n {8}PUSH_BACKOFF_S: '5'\n/);
  assert.match(commit.run, /bash "\$GITHUB_WORKSPACE\/scripts\/push-data\.sh"/);
});

test('pages-deploy: the script is the one the action runs and passes shellcheck when it is installed', () => {
  assert.ok(existsSync(SCRIPT));
  const sc = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' });
  if (sc.status !== 0) return;
  execFileSync('shellcheck', [SCRIPT, join(ROOT, 'scripts', 'push-data.sh')], { encoding: 'utf8' });
});
