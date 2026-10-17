import { z } from 'zod';

/**
 * Environment is validated once, at boot, and the process refuses to start
 * if anything required is missing. A backend that starts with a blank
 * contract id and fails silently at request time is far harder to debug
 * than one that will not start at all.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  READY_MAX_LAG_LEDGERS: z.coerce.number().int().nonnegative().default(120),

  DATABASE_URL: z.string().min(1),

  STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet']).default('testnet'),
  SOROBAN_RPC_URL: z.string().url(),
  NETWORK_PASSPHRASE: z.string().min(1),

  REGISTRY_CONTRACT_ID: z.string().length(56),
  VOUCHER_CONTRACT_ID: z.string().length(56),
  RECEIPT_CONTRACT_ID: z.string().length(56),
  USDC_CONTRACT_ID: z.string().length(56).optional(),

  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(5000),
});

/**
 * Expected network passphrases for each STELLAR_NETWORK value.
 * These match the Stellar SDK Networks constants.
 */
const EXPECTED_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the contract ids printed by scripts/deploy.sh.',
    );
  }

  const config = parsed.data;

  // Validate that NETWORK_PASSPHRASE matches STELLAR_NETWORK at startup.
  // A mismatched passphrase means the backend would query the wrong chain.
  const expectedPassphrase = EXPECTED_PASSPHRASES[config.STELLAR_NETWORK];
  if (expectedPassphrase && config.NETWORK_PASSPHRASE !== expectedPassphrase) {
    throw new Error(
      `NETWORK_PASSPHRASE mismatch for ${config.STELLAR_NETWORK}:\n` +
        `  Expected: ${expectedPassphrase}\n` +
        `  Got:      ${config.NETWORK_PASSPHRASE}\n\n` +
        'Fix your .env file so the passphrase matches the chosen network.',
    );
  }

  return config;
}

export const env = load();

/** Contract ids the indexer subscribes to, in one place. */
export const INDEXED_CONTRACTS = [
  env.REGISTRY_CONTRACT_ID,
  env.VOUCHER_CONTRACT_ID,
  env.RECEIPT_CONTRACT_ID,
] as const;

/**
 * The short name for each configured contract, used to group per-contract
 * history (governance, especially) for readers who think in roles rather
 * than contract ids.
 */
export const CONTRACTS = [
  { contract: 'registry', contractId: env.REGISTRY_CONTRACT_ID },
  { contract: 'voucher', contractId: env.VOUCHER_CONTRACT_ID },
  { contract: 'receipt', contractId: env.RECEIPT_CONTRACT_ID },
] as const;

export function contractName(contractId: string): string {
  return CONTRACTS.find((c) => c.contractId === contractId)?.contract ?? 'unknown';
}
