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
//
// Drips Wave awards points only when the issue assigned to the contributor
// is closed as completed. So a contributor's pull request must link at least
// one issue assigned to them, and after merging the bot closes the linked
// issues itself instead of relying on GitHub's closing keywords.

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
function evaluate({ pr, ciRuns, checkRuns, files, reviews, writers, patterns, author, linkedIssues = [] }) {
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

  // Contributors earn Drips points through the issue, so it must be linked
  // and assigned to them. Maintainers and bots are exempt.
  if (author && !author.isWriter && !author.isBot) {
    if (linkedIssues.length === 0) return { action: 'comment', reason: 'no-linked-issue' };
    const mine = linkedIssues.filter((i) => i.assignees.includes(author.login));
    if (mine.length === 0) {
      return { action: 'comment', reason: 'issue-not-assigned', detail: linkedIssues.map((i) => `#${i.number}`) };
    }
  }

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
  'no-linked-issue': () =>
    'All checks passed, but this pull request is not linked to an issue. Drips Wave awards points only when the issue assigned to you is closed as completed, so it will not be merged until it is linked.\n\nAdd one line per issue to the description, for example:\n\n```\nCloses #123\n```\n\nThe bot checks again as soon as you edit the description.',
  'issue-not-assigned': (issues) =>
    `All checks passed, but the linked issue(s) ${issues.join(', ')} are not assigned to you. Drips Wave gives points to the person assigned to the issue, so apply for it on Drips Wave and get assigned first, or link the issue that is assigned to you. The bot checks again when you edit the description.`,
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

/**
 * Every run evaluates every open pull request, whatever triggered it.
 * Scheduled runs are often dropped by GitHub and queued runs can be
 * superseded, so no pull request may depend on one particular run.
 */
async function openPulls({ github, context }) {
  const { owner, repo } = context.repo;
  return paginate(github, github.rest.pulls.list, { owner, repo, state: 'open' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Approves CI runs that GitHub is holding for maintainer approval (pull
 * requests from first-time contributors). Fork pull request runs get a
 * read-only token and no secrets, so running them is safe; the merge
 * decision still depends on their result.
 */
async function approvePendingRuns({ github, context, core, pulls }) {
  const { owner, repo } = context.repo;
  const shas = new Set(pulls.map((p) => p.head.sha));
  if (shas.size === 0) return 0;

  // A pull request that was just opened or pushed may not have its CI run
  // yet; give GitHub a moment to create it.
  const justPushed =
    context.eventName === 'pull_request_target' &&
    ['opened', 'reopened', 'synchronize'].includes(context.payload.action);
  const attempts = justPushed ? 6 : 1;

  let approved = 0;
  const seen = new Set();
  for (let i = 0; i < attempts; i++) {
    const pending = await paginate(github, github.rest.actions.listWorkflowRunsForRepo, {
      owner, repo, status: 'action_required',
    });
    for (const run of pending) {
      if (seen.has(run.id) || !shas.has(run.head_sha)) continue;
      if (run.event !== 'pull_request' && run.event !== 'pull_request_target') continue;
      seen.add(run.id);
      try {
        await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve', {
          owner, repo, run_id: run.id,
        });
        approved++;
        core.info(`approved ${run.name} run ${run.id} for ${run.head_sha.slice(0, 7)}`);
      } catch (err) {
        core.warning(`could not approve run ${run.id}: ${err.message}`);
      }
    }
    if (justPushed && i < attempts - 1) {
      const sha = context.payload.pull_request.head.sha;
      const runs = await github.rest.actions.listWorkflowRunsForRepo({ owner, repo, head_sha: sha, per_page: 20 });
      const ciExists = runs.data.workflow_runs.some((r) => r.path.endsWith('/ci.yml'));
      const ciPending = runs.data.workflow_runs.some((r) => r.path.endsWith('/ci.yml') && r.conclusion === 'action_required' && !seen.has(r.id));
      if (ciExists && !ciPending) break;
      await sleep(10000);
    }
  }
  return approved;
}

async function alreadyCommented({ github, owner, repo, number, key }) {
  const comments = await paginate(github, github.rest.issues.listComments, { owner, repo, issue_number: number });
  return comments.some((c) => (c.body || '').includes(key));
}

async function linkedIssuesOf({ github, owner, repo, number }) {
  const q = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: 25) {
          nodes { number state assignees(first: 20) { nodes { login } } }
        }
      }
    }
  }`;
  const res = await github.graphql(q, { owner, repo, number });
  return res.repository.pullRequest.closingIssuesReferences.nodes.map((n) => ({
    number: n.number,
    state: n.state,
    assignees: n.assignees.nodes.map((a) => a.login),
  }));
}

async function permissionOf({ github, owner, repo, username }) {
  try {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
    return data.permission;
  } catch {
    return 'none';
  }
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

  const [ciRuns, checkRuns, filesRaw, reviews, linkedIssues, authorPerm] = await Promise.all([
    github.rest.actions
      .listWorkflowRuns({ owner, repo, workflow_id: 'ci.yml', head_sha: sha, per_page: 20 })
      .then((r) => r.data.workflow_runs.filter((w) => w.event === 'pull_request')),
    paginate(github, github.rest.checks.listForRef, { owner, repo, ref: sha }).then((runs) =>
      runs.filter((c) => c.app && c.app.slug === 'github-actions'),
    ),
    paginate(github, github.rest.pulls.listFiles, { owner, repo, pull_number: full.number }),
    paginate(github, github.rest.pulls.listReviews, { owner, repo, pull_number: full.number }),
    linkedIssuesOf({ github, owner, repo, number: full.number }),
    permissionOf({ github, owner, repo, username: full.user.login }),
  ]);
  const author = {
    login: full.user.login,
    isWriter: authorPerm === 'admin' || authorPerm === 'write',
    isBot: full.user.type === 'Bot',
  };
  const files = filesRaw.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));

  const writers = new Set();
  for (const login of new Set(reviews.filter((r) => r.state === 'APPROVED').map((r) => r.user.login))) {
    const perm = await permissionOf({ github, owner, repo, username: login });
    if (perm === 'admin' || perm === 'write') writers.add(login);
  }

  const decision = evaluate({ pr: full, ciRuns, checkRuns, files, reviews, writers, patterns, author, linkedIssues });
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

  // Close linked issues as completed ourselves: Drips awards points on that,
  // and GitHub's closing keywords do not always fire for bot merges.
  const closed = [];
  for (const issue of linkedIssues) {
    const { data } = await github.rest.issues.get({ owner, repo, issue_number: issue.number });
    if (data.state === 'open') {
      await github.rest.issues
        .update({ owner, repo, issue_number: issue.number, state: 'closed', state_reason: 'completed' })
        .catch((e) => {
          // GitHub's own closing keywords often win the race; that is fine.
          if (!/closed by another request/i.test(e.message)) {
            core.warning(`could not close #${issue.number}: ${e.message}`);
          }
        });
    }
    closed.push(`#${issue.number}`);
  }

  await github.rest.issues.createComment({
    owner, repo, issue_number: full.number,
    body: `Merged automatically: every CI check passed on ${sha.slice(0, 7)}.${
      closed.length ? ` Closed ${closed.join(', ')} as completed.` : ''
    } Thank you for contributing!\n\n${MARKER} merged ${sha} -->`,
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
  const pulls = await openPulls({ github, context });
  core.info(`${pulls.length} pull request(s) to evaluate`);
  const approved = await approvePendingRuns({ github, context, core, pulls });
  if (approved) core.info(`approved ${approved} pending CI run(s)`);
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
