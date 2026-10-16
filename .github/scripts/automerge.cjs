// Auto-merge bot.
//
// Merges an open pull request once every GitHub Actions check on its head
// commit has passed. Runs from the default branch only and never checks out
// or executes code from the pull request.
//
// Pull requests that touch a sensitive path (CI config, deploy settings,
// dependency manifests) also need an approval from someone with write access,
// because a pull request's CI runs with the workflow files from that same
// pull request: without this, editing ci.yml to skip the tests would be
// enough to get merged.

const MARKER = '<!-- sci-automerge';
const PASSING = new Set(['success', 'neutral', 'skipped']);
const BOT_JOB = 'auto-merge';

/** Turns a simple glob (`**`, `*`) into a RegExp anchored to the whole path. */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function parsePatterns(text) {
  return (text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .map(globToRegExp);
}

function sensitiveFiles(files, patterns) {
  return files.filter((f) => patterns.some((re) => re.test(f)));
}

/** Latest review per reviewer, then whether any writer approved this exact commit. */
function approvedByWriter(reviews, headSha, writers) {
  const latest = new Map();
  for (const r of reviews) {
    if (r.state === 'COMMENTED' || !r.user) continue;
    latest.set(r.user.login, r);
  }
  return [...latest.values()].some(
    (r) => r.state === 'APPROVED' && r.commit_id === headSha && writers.has(r.user.login),
  );
}

/**
 * Decides what to do with one pull request. Pure, so it can be unit tested.
 *
 * Returns { action: 'merge' | 'wait' | 'comment' | 'skip', reason, detail? }.
 * 'comment' means: do not merge, and tell the author why (once per commit).
 */
function evaluate({ pr, ciRuns, checkRuns, files, reviews, writers, patterns }) {
  if (pr.state !== 'open') return { action: 'skip', reason: 'not-open' };
  if (pr.draft) return { action: 'skip', reason: 'draft' };
  if (pr.labels.some((l) => l.name === 'do-not-merge')) return { action: 'skip', reason: 'do-not-merge' };

  // The CI workflow must have run on this exact commit and passed.
  if (ciRuns.length === 0) return { action: 'wait', reason: 'ci-not-started' };
  const latestCi = [...ciRuns].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (latestCi.status !== 'completed') return { action: 'wait', reason: 'ci-running' };
  // First-time contributors: GitHub holds CI until a maintainer approves the run.
  if (latestCi.conclusion === 'action_required') return { action: 'skip', reason: 'ci-awaiting-approval' };
  if (latestCi.conclusion !== 'success') return { action: 'skip', reason: 'ci-failed' };

  // Every GitHub Actions check on the commit, not only CI, must be green.
  const checks = checkRuns.filter((c) => c.name !== BOT_JOB);
  if (checks.some((c) => c.status !== 'completed')) return { action: 'wait', reason: 'checks-running' };
  const failed = checks.filter((c) => !PASSING.has(c.conclusion));
  if (failed.length) return { action: 'skip', reason: 'checks-failed', detail: failed.map((c) => c.name) };

  if (pr.mergeable === null) return { action: 'wait', reason: 'mergeability-unknown' };
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    return { action: 'comment', reason: 'conflicts' };
  }
  if (pr.mergeable_state === 'behind') return { action: 'comment', reason: 'behind' };

  const touched = sensitiveFiles(files, patterns);
  if (touched.length && !approvedByWriter(reviews, pr.head.sha, writers)) {
    return { action: 'comment', reason: 'needs-approval', detail: touched };
  }

  return { action: 'merge', reason: touched.length ? 'approved' : 'checks-passed' };
}

/**
 * GITHUB_TOKEN may not create or update workflow files. Merging a branch
 * that predates a workflow change on main counts as one, so GitHub rejects
 * it with 403 even though the pull request itself does not touch .github.
 */
function isWorkflowPermissionError(err) {
  return err && err.status === 403 && /not accessible by integration|workflow/i.test(err.message || '');
}

const MESSAGES = {
  conflicts: () =>
    'This pull request has merge conflicts with `main`. Please rebase or merge `main` into your branch; it will be merged automatically once CI passes again.',
  behind: () =>
    'All checks passed, but this branch is behind `main`, and `main` requires branches to be up to date. Please update your branch (merge or rebase `main`); it will be merged automatically once CI passes again.',
  'workflow-drift': () =>
    'All checks passed, but the CI workflows on `main` changed after this branch was created, and the bot is not allowed to merge a branch that would change workflow files. Please update your branch with `main` (merge or rebase); it will be merged automatically once CI passes again.',
  'needs-approval': (files) =>
    `All checks passed. This pull request changes files that control CI, deployment or dependencies, so a maintainer must approve it before it is merged automatically:\n\n${files
      .slice(0, 20)
      .map((f) => `- \`${f}\``)
      .join('\n')}${files.length > 20 ? `\n- …and ${files.length - 20} more` : ''}`,
};

async function paginate(github, fn, params) {
  return github.paginate(fn, { ...params, per_page: 100 });
}

async function candidatePulls({ github, context }) {
  const { owner, repo } = context.repo;
  const open = await paginate(github, github.rest.pulls.list, { owner, repo, state: 'open' });
  if (context.eventName === 'workflow_run') {
    const sha = context.payload.workflow_run.head_sha;
    return open.filter((p) => p.head.sha === sha);
  }
  if (context.eventName === 'pull_request_target') {
    return open.filter((p) => p.number === context.payload.pull_request.number);
  }
  return open;
}

async function alreadyCommented({ github, owner, repo, number, key }) {
  const comments = await paginate(github, github.rest.issues.listComments, { owner, repo, issue_number: number });
  return comments.some((c) => (c.body || '').includes(key));
}

async function handle({ github, context, core, pr, patterns }) {
  const { owner, repo } = context.repo;
  // Re-read: list results do not include mergeability.
  let full = (await github.rest.pulls.get({ owner, repo, pull_number: pr.number })).data;
  for (let i = 0; i < 3 && full.mergeable === null; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    full = (await github.rest.pulls.get({ owner, repo, pull_number: pr.number })).data;
  }
  const sha = full.head.sha;

  const [ciRuns, checkRuns, filesRaw, reviews] = await Promise.all([
    github.rest.actions
      .listWorkflowRuns({ owner, repo, workflow_id: 'ci.yml', head_sha: sha, per_page: 20 })
      .then((r) => r.data.workflow_runs.filter((w) => w.event === 'pull_request')),
    paginate(github, github.rest.checks.listForRef, { owner, repo, ref: sha }).then((runs) =>
      runs.filter((c) => c.app && c.app.slug === 'github-actions'),
    ),
    paginate(github, github.rest.pulls.listFiles, { owner, repo, pull_number: full.number }),
    paginate(github, github.rest.pulls.listReviews, { owner, repo, pull_number: full.number }),
  ]);
  const files = filesRaw.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));

  const writers = new Set();
  for (const login of new Set(reviews.filter((r) => r.state === 'APPROVED').map((r) => r.user.login))) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: login });
    if (data.permission === 'admin' || data.permission === 'write') writers.add(login);
  }

  const decision = evaluate({ pr: full, ciRuns, checkRuns, files, reviews, writers, patterns });
  core.info(`#${full.number} @ ${sha.slice(0, 7)}: ${decision.action} (${decision.reason})`);

  if (decision.action === 'comment') {
    const key = `${MARKER} ${decision.reason} ${sha} -->`;
    if (!(await alreadyCommented({ github, owner, repo, number: full.number, key }))) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: full.number,
        body: `${MESSAGES[decision.reason](decision.detail || [])}\n\n${key}`,
      });
    }
    return decision;
  }
  if (decision.action !== 'merge') return decision;

  try {
    await github.rest.pulls.merge({
      owner, repo, pull_number: full.number, sha, merge_method: 'squash',
      commit_title: `${full.title} (#${full.number})`,
    });
  } catch (err) {
    if (isWorkflowPermissionError(err)) {
      const key = `${MARKER} workflow-drift ${sha} -->`;
      if (!(await alreadyCommented({ github, owner, repo, number: full.number, key }))) {
        await github.rest.issues.createComment({
          owner, repo, issue_number: full.number, body: `${MESSAGES['workflow-drift']()}

${key}`,
        });
      }
      core.info(`#${full.number}: branch predates a workflow change on main; asked the author to update`);
      return { action: 'comment', reason: 'workflow-drift' };
    }
    // Lost a race with a new push or another merge; the next event re-evaluates.
    core.warning(`#${full.number} not merged: ${err.message}`);
    return { action: 'wait', reason: 'merge-rejected' };
  }

  await github.rest.issues.createComment({
    owner, repo, issue_number: full.number,
    body: `Merged automatically: every CI check passed on ${sha.slice(0, 7)}. Thank you for contributing!\n\n${MARKER} merged ${sha} -->`,
  });
  if (full.head.repo && full.head.repo.full_name === `${owner}/${repo}` && full.head.ref !== full.base.ref) {
    await github.rest.git.deleteRef({ owner, repo, ref: `heads/${full.head.ref}` }).catch(() => {});
  }
  return decision;
}

/** After merging with GITHUB_TOKEN, push-triggered workflows do not run by themselves. */
async function afterMerge({ github, context, core }) {
  const { owner, repo } = context.repo;
  const ref = context.payload.repository.default_branch;
  await github.rest.actions
    .createWorkflowDispatch({ owner, repo, workflow_id: 'ci.yml', ref })
    .catch((e) => core.warning(`could not start CI on ${ref}: ${e.message}`));
  if (process.env.REQUEST_PAGES_BUILD === 'true') {
    await github.rest.repos
      .requestPagesBuild({ owner, repo })
      .catch((e) => core.warning(`could not request a Pages build: ${e.message}`));
  }
}

async function run({ github, context, core }) {
  const patterns = parsePatterns(process.env.SENSITIVE_PATHS);
  const pulls = await candidatePulls({ github, context });
  core.info(`${pulls.length} pull request(s) to evaluate`);
  let merged = 0;
  for (const pr of pulls) {
    try {
      const d = await handle({ github, context, core, pr, patterns });
      if (d.action === 'merge') merged++;
    } catch (err) {
      core.warning(`#${pr.number}: ${err.message}`);
    }
  }
  if (merged) await afterMerge({ github, context, core });
}

module.exports = run;
module.exports.evaluate = evaluate;
module.exports.globToRegExp = globToRegExp;
module.exports.parsePatterns = parsePatterns;
module.exports.approvedByWriter = approvedByWriter;
module.exports.isWorkflowPermissionError = isWorkflowPermissionError;
