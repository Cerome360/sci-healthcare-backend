import { TEST_DATABASE_URL } from './database-url.js';

/**
 * Minimal valid configuration for tests. Contract ids only need the right
 * shape: nothing under test talks to the network. They are distinct so
 * handlers that tag rows by contract can be tested.
 */
const contractId = (seed: string): string => `C${seed}`.padEnd(56, 'A');

Object.assign(process.env, {
  DATABASE_URL: TEST_DATABASE_URL,
  LOG_LEVEL: 'error',
  SOROBAN_RPC_URL: 'http://localhost:8000/soroban/rpc',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  REGISTRY_CONTRACT_ID: contractId('REGISTRY'),
  VOUCHER_CONTRACT_ID: contractId('VOUCHER'),
  RECEIPT_CONTRACT_ID: contractId('RECEIPT'),
  // Webhooks are enabled so the outbox and signature paths are exercised.
  // The URL is never dialled: tests inject their own fetch.
  WEBHOOK_URLS: 'https://clinic.example.test/webhooks',
  WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
});
