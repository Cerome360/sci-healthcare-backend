import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Load mock test environment so buildApp() can construct without missing env variables
import '../test/env.js';
import { buildApp } from '../src/app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const clientDir = resolve(rootDir, 'packages', 'client');

async function main() {
  console.log('Building Fastify app to export OpenAPI specification...');
  const app = await buildApp({ logger: false });
  await app.ready();

  const spec = app.swagger();
  await app.close();

  const pathCount = Object.keys(spec.paths || {}).length;
  console.log(`Extracted OpenAPI ${spec.openapi} with ${pathCount} paths`);

  if (pathCount === 0) {
    throw new Error('OpenAPI specification contains no paths');
  }

  // Ensure directories exist
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(resolve(clientDir, 'src'), { recursive: true });

  // Write openapi.json to root and package
  const specJson = JSON.stringify(spec, null, 2) + '\n';
  writeFileSync(resolve(rootDir, 'openapi.json'), specJson, 'utf8');
  writeFileSync(resolve(clientDir, 'openapi.json'), specJson, 'utf8');
  console.log('Wrote openapi.json to root and packages/client/');

  console.log('Compiling @sci-healthcare/client TypeScript...');
  execFileSync(
    'npx',
    ['tsc', '-p', resolve(clientDir, 'tsconfig.json')],
    { cwd: rootDir, stdio: 'inherit' },
  );

  console.log('Client build completed successfully.');
}

main().catch((err) => {
  console.error('Failed to generate client:', err);
  process.exit(1);
});
