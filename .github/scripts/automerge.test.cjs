const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluate, parsePatterns, approvedByWriter } = require('./automerge.cjs');

const SHA = 'a'.repeat(40);
const patterns = parsePatterns(`
# comments ignored
.github/**
scripts/**
package.json
**/Cargo.toml
`);

function pr(over = {}) {
  return {
    number: 7, state: 'open', draft: false, labels: [], mergeable: true,
    mergeable_state: 'clean', head: { sha: SHA }, ...over,
  };
}
const ci = (status = 'completed', conclusion = 'success') => [
  { status, conclusion, created_at: '2026-10-16T10:00:00Z' },
];
const checks = (...xs) => xs.map(([name, status = 'completed', conclusion = 'success']) => ({ name, status, conclusion }));

function base(over = {}) {
  return {
    pr: pr(), ciRuns: ci(), checkRuns: checks(['lint'], ['test']),
    files: ['src/app.ts'], reviews: [], writers: new Set(), patterns, ...over,
  };
}

test('merges when every check passed and nothing sensitive changed', () => {
  assert.deepEqual(evaluate(base()), { action: 'merge', reason: 'checks-passed' });
});

test('skips drafts, closed pull requests and do-not-merge', () => {
  assert.equal(evaluate(base({ pr: pr({ draft: true }) })).reason, 'draft');
  assert.equal(evaluate(base({ pr: pr({ state: 'closed' }) })).reason, 'not-open');
  assert.equal(evaluate(base({ pr: pr({ labels: [{ name: 'do-not-merge' }] }) })).reason, 'do-not-merge');
});

test('waits until CI has run on this commit and finished', () => {
  assert.equal(evaluate(base({ ciRuns: [] })).reason, 'ci-not-started');
  assert.equal(evaluate(base({ ciRuns: ci('in_progress', null) })).reason, 'ci-running');
});

test('never merges a failed CI run, and uses the latest run', () => {
  assert.equal(evaluate(base({ ciRuns: ci('completed', 'failure') })).action, 'skip');
  const rerun = [
    { status: 'completed', conclusion: 'failure', created_at: '2026-10-16T09:00:00Z' },
    { status: 'completed', conclusion: 'success', created_at: '2026-10-16T10:00:00Z' },
  ];
  assert.equal(evaluate(base({ ciRuns: rerun })).action, 'merge');
});

test('every Actions check must pass, ignoring the bot itself', () => {
  assert.equal(evaluate(base({ checkRuns: checks(['lint', 'in_progress', null]) })).reason, 'checks-running');
  const failed = evaluate(base({ checkRuns: checks(['lint'], ['test', 'completed', 'failure']) }));
  assert.deepEqual([failed.action, failed.detail], ['skip', ['test']]);
  assert.equal(evaluate(base({ checkRuns: checks(['test'], ['auto-merge', 'in_progress', null]) })).action, 'merge');
  assert.equal(evaluate(base({ checkRuns: checks(['docs', 'completed', 'skipped']) })).action, 'merge');
});

test('asks the author to resolve conflicts or update the branch', () => {
  assert.equal(evaluate(base({ pr: pr({ mergeable: false, mergeable_state: 'dirty' }) })).reason, 'conflicts');
  assert.equal(evaluate(base({ pr: pr({ mergeable_state: 'behind' }) })).reason, 'behind');
  assert.equal(evaluate(base({ pr: pr({ mergeable: null }) })).action, 'wait');
});

test('sensitive files need a writer approval on the current commit', () => {
  const files = ['src/app.ts', '.github/workflows/ci.yml', 'contracts/voucher/Cargo.toml'];
  const blocked = evaluate(base({ files }));
  assert.deepEqual([blocked.action, blocked.reason, blocked.detail],
    ['comment', 'needs-approval', ['.github/workflows/ci.yml', 'contracts/voucher/Cargo.toml']]);

  const approval = [{ user: { login: 'maint' }, state: 'APPROVED', commit_id: SHA }];
  assert.equal(evaluate(base({ files, reviews: approval, writers: new Set(['maint']) })).action, 'merge');
  // Approval by someone without write access does not count.
  assert.equal(evaluate(base({ files, reviews: approval, writers: new Set() })).action, 'comment');
  // Approval of an older commit does not count.
  const stale = [{ user: { login: 'maint' }, state: 'APPROVED', commit_id: 'b'.repeat(40) }];
  assert.equal(evaluate(base({ files, reviews: stale, writers: new Set(['maint']) })).action, 'comment');
});

test('a later change request cancels an approval', () => {
  const reviews = [
    { user: { login: 'maint' }, state: 'APPROVED', commit_id: SHA },
    { user: { login: 'maint' }, state: 'CHANGES_REQUESTED', commit_id: SHA },
  ];
  assert.equal(approvedByWriter(reviews, SHA, new Set(['maint'])), false);
});

test('glob patterns match whole paths only', () => {
  const [gh, , pkg, cargo] = patterns;
  assert.ok(gh.test('.github/workflows/ci.yml'));
  assert.ok(!gh.test('docs/.github/x'));
  assert.ok(pkg.test('package.json'));
  assert.ok(!pkg.test('packages/package.json.bak'));
  assert.ok(cargo.test('Cargo.toml'));
  assert.ok(cargo.test('contracts/voucher/Cargo.toml'));
});
