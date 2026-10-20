// Security gate for pull requests.
//
// Runs from the default branch under pull_request_target and treats the pull
// request purely as data: it reads git objects and lockfiles, and never
// checks out, installs, builds or executes anything from the pull request.
// The result is posted as the `security-scan` commit status on the pull
// request's head commit, which the auto-merge bot and branch protection
// require.
//
// Findings are either:
//   block  - known-malicious or near-certainly hostile; never auto-merged
//   review - legitimate in some PRs but a common malware vector; passes only
//            after a maintainer applies the `security-reviewed` label to the
//            current head commit
//   info   - reported for context only (e.g. adding a long-established,
//            widely used package); does not affect the result

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REVIEW_LABEL = 'security-reviewed';
const STATUS_CONTEXT = 'security-scan';

// ---------------------------------------------------------------- rules

const BLOCK = 'block';
const REVIEW = 'review';
const INFO = 'info';

// Bidirectional overrides and invisible characters ("Trojan Source").
const HIDDEN_UNICODE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\u00AD\u2060\uFEFF]/;

const LINE_RULES = [
  { severity: BLOCK, rule: 'crypto-miner', re: /stratum\+(tcp|ssl):\/\/|\bcoinhive\b|\bcryptonight\b|\bxmrig\b|\bminexmr\b|\bnicehash\b/i,
    message: 'Cryptocurrency-miner reference.' },
  { severity: BLOCK, rule: 'reverse-shell', re: /\/dev\/tcp\/|\bnc\s+(-\w+\s+)*-e\b|\bbash\s+-i\s+>&|\bmkfifo\b.*\bnc\b|\bsocat\b.*\bexec:/i,
    message: 'Reverse-shell pattern.' },
  { severity: BLOCK, rule: 'pipe-to-shell', re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i,
    message: 'Downloads a script and pipes it into a shell.' },
  { severity: BLOCK, rule: 'credential-file', re: /(\.npmrc|\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\.config\/gh\/hosts\.yml|\.git-credentials)\b/,
    message: 'Reads or references a credentials file.' },
  { severity: REVIEW, rule: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(runIn\w+|Script)\b|\bsetTimeout\s*\(\s*['"`]|\bsetInterval\s*\(\s*['"`]/,
    message: 'Executes code built at runtime (eval, new Function, vm).' },
  { severity: REVIEW, rule: 'process-spawn', re: /\bchild_process\b|\bexecSync\s*\(|\bspawnSync?\s*\(|\bexecFile(Sync)?\s*\(|std::process::Command|\bCommand::new\s*\(/,
    message: 'Starts another process.' },
  { severity: REVIEW, rule: 'obfuscation', re: /(\\x[0-9a-fA-F]{2}){12,}|(\\u[0-9a-fA-F]{4}){12,}|String\.fromCharCode\s*\(\s*\d+(\s*,\s*\d+){8,}|\batob\s*\(|Buffer\.from\s*\([^)]*['"]base64['"]\s*\)/,
    message: 'Encoded or obfuscated content (hex/unicode escapes, char codes, base64 decoding).' },
  { severity: REVIEW, rule: 'long-encoded-string', re: /['"`][A-Za-z0-9+/=_-]{200,}['"`]/,
    message: 'Very long encoded string literal.' },
  { severity: REVIEW, rule: 'env-exfiltration', re: /JSON\.stringify\s*\(\s*process\.env\s*\)|Object\.(entries|keys|values)\s*\(\s*process\.env\s*\)|\bprocess\.env\b[^\n]*\b(fetch|axios|request|https?\.request)\s*\(/,
    message: 'Collects environment variables, possibly to send them somewhere.' },
  { severity: REVIEW, rule: 'wallet-secret', re: /\b(secret[_-]?key|private[_-]?key|seed[_-]?phrase|mnemonic)\b[^\n]*\b(fetch|send|post|axios|beacon)\b|\bS[A-Z2-7]{55}\b/,
    message: 'Handles a wallet secret key or seed (or contains an S... secret key).' },
];

const URL_RE = /\bhttps?:\/\/([a-zA-Z0-9.-]+)/g;
const STELLAR_ADDRESS_RE = /\b[GC][A-Z2-7]{55}\b/g;

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.jar', '.class', '.pyc', '.node', '.scr', '.msi', '.dmg', '.apk',
  '.app', '.com', '.cpl', '.sys', '.elf', '.out', '.wasm',
]);
const REVIEW_EXTENSIONS = new Set(['.sh', '.bat', '.cmd', '.ps1', '.vbs', '.py', '.rb', '.pl']);
const BINARY_OK_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.avif']);

const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare'];

function ext(p) {
  return path.extname(p).toLowerCase();
}

function matchesAny(p, globs) {
  return (globs || []).some((g) => globToRegExp(g).test(p));
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function hostAllowed(host, allowedHosts) {
  const h = host.toLowerCase();
  return allowedHosts.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Checks lines added by the pull request in one text file. */
function scanAddedLines(file, added, config) {
  const findings = [];
  const isData = matchesAny(file, config.dataPaths);
  for (const { line, text } of added) {
    if (HIDDEN_UNICODE.test(text) && !(line === 1 && text.startsWith('\uFEFF') && !HIDDEN_UNICODE.test(text.slice(1)))) {
      findings.push({ severity: BLOCK, rule: 'hidden-unicode', path: file, line,
        message: 'Invisible or bidirectional Unicode characters (Trojan Source): the code may not do what it appears to.' });
    }
    for (const r of LINE_RULES) {
      if (r.re.test(text) && !(isData && r.severity === REVIEW)) {
        findings.push({ severity: r.severity, rule: r.rule, path: file, line, message: r.message });
      }
    }
    if (text.length > 1000 && !isData && !/\.(md|svg|json|lock|map)$/i.test(file)) {
      findings.push({ severity: REVIEW, rule: 'minified-code', path: file, line, message: 'Very long line; minified or generated code hides behaviour.' });
    }
    if (!isData) {
      for (const m of text.matchAll(URL_RE)) {
        if (!hostAllowed(m[1], config.allowedHosts)) {
          findings.push({ severity: REVIEW, rule: 'new-network-host', path: file, line, message: `Contacts a host not on the allow-list: ${m[1]}.` });
        }
      }
      for (const m of text.matchAll(STELLAR_ADDRESS_RE)) {
        if (!config.allowedAddresses.includes(m[0])) {
          findings.push({ severity: REVIEW, rule: 'new-stellar-address', path: file, line,
            message: `Hard-coded Stellar address ${m[0].slice(0, 6)}...${m[0].slice(-4)}: could redirect funds.` });
        }
      }
    }
  }
  return findings;
}

/** Checks a changed file as a whole (type, binary content, sensitive paths). */
function scanFile(file, status, content, config) {
  const findings = [];
  const e = ext(file);
  if (status !== 'D') {
    if (BLOCKED_EXTENSIONS.has(e) && !matchesAny(file, config.allowedBinaries)) {
      findings.push({ severity: BLOCK, rule: 'executable-file', path: file, message: `Adds or changes an executable or compiled binary (${e}).` });
    } else if (content && content.includes(0) && !BINARY_OK_EXTENSIONS.has(e) && !matchesAny(file, config.allowedBinaries)) {
      findings.push({ severity: BLOCK, rule: 'unexpected-binary', path: file, message: 'Binary content in a file that should be text.' });
    } else if (REVIEW_EXTENSIONS.has(e)) {
      findings.push({ severity: REVIEW, rule: 'script-file', path: file, message: `Adds or changes a ${e} script.` });
    }
    // SVGs are served as images but can carry script.
    if (e === '.svg' && content && /<script\b|javascript:|\son[a-z]+\s*=/i.test(content.toString('utf8'))) {
      findings.push({ severity: REVIEW, rule: 'svg-script', path: file, message: 'SVG with script or event handlers.' });
    }
    if (/(^|\/)build\.rs$/.test(file)) {
      findings.push({ severity: REVIEW, rule: 'cargo-build-script', path: file, message: 'Cargo build script: runs arbitrary code at compile time.' });
    }
    if (/(^|\/)\.npmrc$/.test(file) && content) {
      const text = content.toString('utf8');
      const reg = text.match(/registry\s*=\s*(\S+)/i);
      if (reg && !/^https:\/\/registry\.npmjs\.org\/?$/i.test(reg[1])) {
        findings.push({ severity: BLOCK, rule: 'registry-override', path: file, message: `Points npm at another registry: ${reg[1]}.` });
      }
      if (/_authToken|_auth\s*=|always-auth/i.test(text)) {
        findings.push({ severity: BLOCK, rule: 'npm-credentials', path: file, message: 'Puts npm credentials in the repository.' });
      }
    }
    if (/(^|\/)\.(husky|githooks)\//.test(file) || /(^|\/)\.git\/hooks\//.test(file)) {
      findings.push({ severity: REVIEW, rule: 'git-hook', path: file, message: 'Git hook: runs on contributors\' machines.' });
    }
  }
  if (matchesAny(file, config.sensitivePaths) && !matchesAny(file, config.dataPaths)) {
    findings.push({ severity: REVIEW, rule: 'sensitive-path', path: file,
      message: 'Changes a security-sensitive file (keys, signing, secrets, contracts or deployment); a maintainer must read this diff.' });
  }
  return findings;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function levenshtein(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Compares a package.json before and after: new dependencies, scripts, registries. */
function scanPackageJson(file, baseText, headText) {
  const findings = [];
  const base = parseJson(baseText) || {};
  const head = parseJson(headText);
  if (!head) return findings;
  const deps = (p) => ({ ...(p.dependencies || {}), ...(p.devDependencies || {}), ...(p.optionalDependencies || {}), ...(p.peerDependencies || {}) });
  const before = deps(base);
  const after = deps(head);
  const added = [];
  for (const [name, spec] of Object.entries(after)) {
    if (!(name in before)) added.push(name);
    if (before[name] === spec) continue;
    // A folder inside this repository is reviewable; anything else off the registry is not.
    const local = /^(file|link):(?!\/|[A-Za-z]:|~)(?!.*\.\.)/.test(String(spec));
    if (local) {
      findings.push({ severity: REVIEW, rule: 'local-dependency', path: file,
        message: `Dependency ${name} is installed from ${spec}, a folder in this repository.` });
    } else if (/^(git|git\+\w+|github|gitlab|bitbucket|gist|https?|file|link):|^[\w-]+\/[\w.-]+(#.*)?$/.test(String(spec))) {
      findings.push({ severity: BLOCK, rule: 'non-registry-dependency', path: file,
        message: `Dependency ${name} is installed from ${spec}, not the npm registry.` });
    }
    // "name": "npm:other@1" installs a different package under a trusted name.
    if (/^npm:/.test(String(spec)) && before[name] !== spec) {
      findings.push({ severity: REVIEW, rule: 'package-alias', path: file,
        message: `${name} is an alias for ${spec}: a different package installed under this name.` });
    }
  }
  // Only a scope's owner can publish inside it, so look-alikes in the same
  // scope are siblings, not typosquats; very short names collide by chance.
  const scopeOf = (n) => (n.startsWith('@') ? n.split('/')[0] : '');
  for (const name of added) {
    const similar = name.length >= 5 && Object.keys(before).find((known) => known !== name
      && !(scopeOf(name) && scopeOf(name) === scopeOf(known)) && levenshtein(known, name) <= 2);
    findings.push(similar
      ? { severity: BLOCK, rule: 'typosquat', path: file, message: `New dependency ${name} looks like the existing ${similar} (possible typosquat).` }
      : { severity: REVIEW, rule: 'new-dependency', path: file, message: `Adds dependency ${name}.`, pkg: name, spec: String(after[name]) });
  }
  const bs = base.scripts || {};
  const hs = head.scripts || {};
  for (const [k, v] of Object.entries(hs)) {
    if (bs[k] !== v) {
      findings.push({ severity: REVIEW, rule: INSTALL_SCRIPTS.includes(k) ? 'install-script' : 'npm-script', path: file,
        message: INSTALL_SCRIPTS.includes(k) ? `Changes the "${k}" lifecycle script, which runs on every install.` : `Changes the "${k}" npm script.` });
    }
  }
  const registry = head.publishConfig && head.publishConfig.registry;
  if (registry && !/^https:\/\/registry\.npmjs\.org\/?$/.test(registry)) {
    findings.push({ severity: BLOCK, rule: 'registry-override', path: file, message: `publishConfig points at ${registry}.` });
  }
  return findings;
}

/** Checks package-lock.json: every package from the npm registry, with integrity; new install scripts. */
function scanNpmLock(file, baseText, headText) {
  const findings = [];
  const head = parseJson(headText);
  if (!head || !head.packages) return findings;
  const base = parseJson(baseText) || { packages: {} };
  for (const [key, pkg] of Object.entries(head.packages)) {
    if (!key || pkg.link) continue;
    if (pkg.resolved && !pkg.resolved.startsWith('https://registry.npmjs.org/')) {
      findings.push({ severity: BLOCK, rule: 'lockfile-host', path: file, message: `${key} resolves to ${pkg.resolved}, not registry.npmjs.org.` });
    }
    if (pkg.resolved && !pkg.integrity) {
      findings.push({ severity: BLOCK, rule: 'lockfile-integrity', path: file, message: `${key} has no integrity hash.` });
    }
    const prev = (base.packages || {})[key];
    if (pkg.hasInstallScript && !(prev && prev.hasInstallScript && prev.version === pkg.version)) {
      findings.push({ severity: REVIEW, rule: 'dependency-install-script', path: file,
        message: `${key.replace(/^.*node_modules\//, '')}@${pkg.version} runs an install script.` });
    }
  }
  return findings;
}

/** Checks Cargo.lock: crates only from crates.io. */
function scanCargoLock(file, headText, config) {
  const findings = [];
  if (!headText) return findings;
  for (const block of headText.split('[[package]]').slice(1)) {
    const name = (block.match(/name\s*=\s*"([^"]+)"/) || [])[1];
    const source = (block.match(/source\s*=\s*"([^"]+)"/) || [])[1];
    if (source && !source.startsWith('registry+https://github.com/rust-lang/crates.io-index') && !(config.allowedCrateSources || []).includes(source)) {
      findings.push({ severity: BLOCK, rule: 'crate-source', path: file, message: `Crate ${name} comes from ${source}, not crates.io.` });
    }
  }
  return findings;
}

/** Turns findings into a decision. */
function decide(findings, reviewed) {
  const blocks = findings.filter((f) => f.severity === BLOCK);
  const reviews = findings.filter((f) => f.severity === REVIEW);
  if (blocks.length) return { state: 'failure', description: `${blocks.length} blocking finding(s): not auto-mergeable` };
  if (reviews.length && !reviewed) return { state: 'failure', description: `${reviews.length} finding(s) need a maintainer security review` };
  if (reviews.length) return { state: 'success', description: `${reviews.length} finding(s) reviewed by a maintainer` };
  return { state: 'success', description: 'No suspicious changes found' };
}

// ---------------------------------------------------------------- runner

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitBuffer(...args) {
  try {
    return execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function addedLinesByFile(base, head) {
  const out = {};
  let file = null;
  let lineNo = 0;
  for (const raw of git('diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...${head}`).split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      if (file) out[file] = out[file] || [];
    } else if (raw.startsWith('@@')) {
      lineNo = Number((raw.match(/\+(\d+)/) || [0, 0])[1]);
    } else if (file && raw.startsWith('+')) {
      out[file].push({ line: lineNo, text: raw.slice(1) });
      lineNo++;
    }
  }
  return out;
}

const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : null);

/**
 * Registry facts about a package: whether it exists, how old it is, weekly
 * downloads, and how old the version the spec would install is.
 */
async function npmPackageInfo(name, spec) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { exists: false };
    const data = await res.json();
    const time = data.time || {};
    const exact = String(spec || '').replace(/^[\^~=v]/, '');
    const version = time[exact] ? exact : (data['dist-tags'] || {}).latest;
    let weeklyDownloads = null;
    try {
      const d = await fetch(`https://api.npmjs.org/downloads/point/last-week/${name}`, { signal: AbortSignal.timeout(10000) });
      if (d.ok) weeklyDownloads = (await d.json()).downloads;
    } catch { /* downloads are a hint only */ }
    return { exists: true, ageDays: daysSince(time.created), version, versionAgeDays: daysSince(time[version]), weeklyDownloads };
  } catch {
    return { exists: null };
  }
}

/**
 * Established packages (old and widely downloaded) are reported but need no
 * review; a version published in the last few days still does, since that is
 * when hijacked releases are live before anyone notices.
 */
function classifyNewDependency(finding, info, config) {
  if (info.exists === false) {
    return [{ severity: BLOCK, rule: 'unknown-package', path: finding.path,
      message: `${finding.pkg} does not exist on the npm registry (possible dependency confusion).` }];
  }
  if (info.exists !== true) return [];
  const notes = [];
  if (info.ageDays !== null && info.ageDays < (config.minPackageAgeDays || 30)) notes.push(`first published ${Math.floor(info.ageDays)} day(s) ago`);
  if (info.weeklyDownloads !== null) notes.push(`${info.weeklyDownloads.toLocaleString('en-US')} downloads last week`);
  const freshVersion = info.versionAgeDays !== null && info.versionAgeDays < (config.minVersionAgeDays || 3);
  if (freshVersion) notes.push(`version ${info.version} published ${Math.floor(info.versionAgeDays * 24)} hour(s) ago`);
  if (notes.length) finding.message += ` (${notes.join('; ')})`;
  const established = info.ageDays !== null && info.ageDays >= (config.establishedPackageAgeDays || 365)
    && info.weeklyDownloads !== null && info.weeklyDownloads >= (config.establishedWeeklyDownloads || 50000);
  if (established && !freshVersion) finding.severity = INFO;
  return [];
}

function runOsv(lockfiles, osvBinary) {
  const findings = [];
  if (!osvBinary || lockfiles.length === 0) return { findings, vulnerabilities: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-'));
  const args = ['scan', 'source', '--format', 'json'];
  lockfiles.forEach(({ name, content }, i) => {
    const sub = path.join(dir, String(i));
    fs.mkdirSync(sub);
    const p = path.join(sub, path.basename(name));
    fs.writeFileSync(p, content);
    args.push('-L', p);
  });
  let out;
  try {
    out = execFileSync(osvBinary, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    out = err.stdout; // exits non-zero when anything is found
  }
  const data = parseJson(out) || { results: [] };
  let vulnerabilities = 0;
  for (const r of data.results || []) {
    for (const p of r.packages || []) {
      for (const v of p.vulnerabilities || []) {
        vulnerabilities++;
        if (String(v.id).startsWith('MAL-')) {
          findings.push({ severity: BLOCK, rule: 'known-malware', path: 'lockfile',
            message: `${p.package.name}@${p.package.version} is a known malicious package (${v.id}).` });
        }
      }
    }
  }
  return { findings, vulnerabilities };
}

function formatReport(findings, decision, vulnerabilities) {
  const icon = decision.state === 'success' ? 'passed' : 'failed';
  const lines = [`## Security scan ${icon}`, '', decision.description + '.', ''];
  if (findings.length) {
    lines.push('| Severity | Rule | Where | Finding |', '| --- | --- | --- | --- |');
    for (const f of findings.slice(0, 100)) {
      lines.push(`| ${f.severity} | \`${f.rule}\` | \`${f.path}${f.line ? `:${f.line}` : ''}\` | ${f.message.replace(/\|/g, '\\|')} |`);
    }
    if (findings.length > 100) lines.push(`| | | | ...and ${findings.length - 100} more |`);
    lines.push('');
  }
  if (vulnerabilities) lines.push(`OSV also reports ${vulnerabilities} known vulnerabilities (not malware) in the lockfiles; the audit job covers those.`, '');
  lines.push('**block** findings are never merged automatically. **review** findings pass once a maintainer has reviewed the change and applied the `security-reviewed` label to the latest commit (pushing again clears it). **info** findings are context only.');
  return lines.join('\n');
}

async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  // workflow_dispatch scans a pull request by number.
  const pr = context.payload.pull_request
    || (await github.rest.pulls.get({ owner, repo, pull_number: Number(process.env.PR_NUMBER) })).data;
  const headSha = pr.head.sha;
  const config = JSON.parse(fs.readFileSync(path.join(process.env.TRUSTED_DIR, '.github/security-scan.json'), 'utf8'));

  // On a new push the review label no longer applies: remove it, and never
  // honour it in the same run.
  const labels = (pr.labels || []).map((l) => l.name);
  if (context.payload.action === 'synchronize' && labels.includes(REVIEW_LABEL)) {
    await github.rest.issues.removeLabel({ owner, repo, issue_number: pr.number, name: REVIEW_LABEL }).catch(() => {});
  }
  let reviewed = false;
  if (context.payload.action === 'labeled' && context.payload.label && context.payload.label.name === REVIEW_LABEL) {
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username: context.payload.sender.login });
    reviewed = data.permission === 'admin' || data.permission === 'write';
    if (!reviewed) core.warning(`${context.payload.sender.login} cannot approve security findings`);
  }

  const base = git('merge-base', pr.base.sha, headSha).trim();
  const changes = git('diff', '--name-status', '--no-renames', `${base}...${headSha}`).trim().split('\n').filter(Boolean)
    .map((l) => { const [status, ...rest] = l.split('\t'); return { status: status[0], file: rest.join('\t') }; });
  const added = addedLinesByFile(base, headSha);

  const findings = [];
  const lockfiles = [];
  for (const { status, file } of changes) {
    const content = status === 'D' ? null : gitBuffer('show', `${headSha}:${file}`);
    findings.push(...scanFile(file, status, content, config));
    const isText = content && !content.includes(0);
    if (isText && added[file] && !/(^|\/)(package-lock\.json|Cargo\.lock|yarn\.lock|pnpm-lock\.yaml)$/.test(file) && !/test_snapshots\//.test(file)) {
      findings.push(...scanAddedLines(file, added[file], config));
    }
    const baseText = () => { const b = gitBuffer('show', `${base}:${file}`); return b ? b.toString('utf8') : null; };
    if (/(^|\/)package\.json$/.test(file) && isText) findings.push(...scanPackageJson(file, baseText(), content.toString('utf8')));
    if (/(^|\/)package-lock\.json$/.test(file) && isText) findings.push(...scanNpmLock(file, baseText(), content.toString('utf8')));
    if (/(^|\/)Cargo\.lock$/.test(file) && isText) findings.push(...scanCargoLock(file, content.toString('utf8'), config));
  }

  // Every lockfile at the head is checked against OSV's malware database,
  // not only changed ones: a newly published advisory should stop merges too.
  for (const name of ['package-lock.json', 'Cargo.lock']) {
    const c = gitBuffer('show', `${headSha}:${name}`);
    if (c) lockfiles.push({ name, content: c });
  }
  const osv = runOsv(lockfiles, process.env.OSV_SCANNER);
  findings.push(...osv.findings);

  // New dependencies: missing from the registry (dependency confusion) blocks;
  // brand-new packages are flagged for review.
  for (const f of findings.filter((x) => x.rule === 'new-dependency')) {
    findings.push(...classifyNewDependency(f, await npmPackageInfo(f.pkg, f.spec), config));
  }

  const decision = decide(findings, reviewed);
  const report = formatReport(findings, decision, osv.vulnerabilities);
  await core.summary.addRaw(report).write();
  for (const f of findings) {
    const props = { title: `${f.severity}: ${f.rule}`, file: f.path === 'lockfile' ? undefined : f.path, startLine: f.line };
    (f.severity === BLOCK ? core.error : f.severity === REVIEW ? core.warning : core.notice)(f.message, props);
  }

  const runUrl = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  await github.rest.repos.createCommitStatus({
    owner, repo, sha: headSha, state: decision.state, context: STATUS_CONTEXT,
    description: decision.description.slice(0, 140), target_url: runUrl,
  });

  // One comment per head commit when something needs attention.
  if (findings.length && decision.state === 'failure') {
    const marker = `<!-- security-scan ${headSha} -->`;
    const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
    if (!comments.some((c) => (c.body || '').includes(marker))) {
      await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: `${report}\n\n${marker}` });
    }
  }
  core.info(`${decision.state}: ${decision.description}`);
}

module.exports = run;
Object.assign(module.exports, {
  scanAddedLines, scanFile, scanPackageJson, scanNpmLock, scanCargoLock, decide, classifyNewDependency, globToRegExp, levenshtein,
  BLOCK, REVIEW, INFO,
});
