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
  // One of these two is required. `SOROBAN_RPC_URLS` is the comma-separated
  // form that allows a standby endpoint; `SOROBAN_RPC_URL` is the original
  // single-endpoint variable and is still honoured.
  SOROBAN_RPC_URL: z.string().url().optional(),
  SOROBAN_RPC_URLS: z.string().optional(),
  /**
   * Consecutive failures against one endpoint before the pool rotates to the
   * next. One blip is not an outage, so the default waits for a small streak.
   */
  SOROBAN_RPC_MAX_FAILURES: z.coerce.number().int().positive().default(3),
  NETWORK_PASSPHRASE: z.string().min(1),

  REGISTRY_CONTRACT_ID: z.string().length(56),
  VOUCHER_CONTRACT_ID: z.string().length(56),
  RECEIPT_CONTRACT_ID: z.string().length(56),
  USDC_CONTRACT_ID: z.string().length(56).optional(),
  /** Testnet demo faucet. Drips are counted only when this is set. */
  FAUCET_CONTRACT_ID: z.string().length(56).optional(),

  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(5000),
  /** Ceiling for the indexer's exponential backoff after RPC failures. */
  INDEXER_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
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

export type Env = Omit<z.infer<typeof schema>, 'SOROBAN_RPC_URL'> & {
  /** The first configured endpoint; kept for callers that want just one. */
  SOROBAN_RPC_URL: string;
  /** Every configured endpoint, in failover order. Never empty. */
  RPC_URLS: readonly string[];
};

/**
 * Parses the endpoint list, preferring `SOROBAN_RPC_URLS` and falling back to
 * the single `SOROBAN_RPC_URL`. Duplicates are dropped so a copy-paste in the
 * list cannot make the pool rotate onto the endpoint that just failed.
 */
export function parseRpcUrls(list: string | undefined, single: string | undefined): string[] {
  const raw = (list ?? single ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of raw) {
    if (!URL.canParse(url)) throw new Error(`SOROBAN_RPC_URLS contains an invalid URL: ${url}`);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Hides any credentials in an RPC URL before it reaches a log or a response. */
export function redactRpcUrl(url: string): string {
  return url.replace(/:\/\/[^/]+@/, '://***@');
}

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

  const rpcUrls = parseRpcUrls(config.SOROBAN_RPC_URLS, config.SOROBAN_RPC_URL);
  if (rpcUrls.length === 0) {
    throw new Error(
      'No Soroban RPC endpoint configured.\n' +
        '  Set SOROBAN_RPC_URLS to a comma-separated list, or SOROBAN_RPC_URL to one endpoint.',
    );
  }

  return { ...config, SOROBAN_RPC_URL: rpcUrls[0]!, RPC_URLS: rpcUrls };
}

export const env = load();

/** Every configured RPC endpoint, in failover order. */
export const RPC_URLS = env.RPC_URLS;

/**
 * Contract ids the indexer subscribes to, in one place.
 *
 * The faucet is only present on a testnet demo, so it joins the list when
 * `FAUCET_CONTRACT_ID` is set and is absent otherwise.
 */
export const INDEXED_CONTRACTS: readonly string[] = [
  env.REGISTRY_CONTRACT_ID,
  env.VOUCHER_CONTRACT_ID,
  env.RECEIPT_CONTRACT_ID,
  ...(env.FAUCET_CONTRACT_ID ? [env.FAUCET_CONTRACT_ID] : []),
];

/**
 * The short name for each configured contract, used to group per-contract
 * history (governance, especially) for readers who think in roles rather
 * than contract ids.
 *
 * The faucet is deliberately absent: it has an admin but emits no admin
 * events, so listing it under `/governance` would only add an empty row.
 */
export const CONTRACTS = [
  { contract: 'registry', contractId: env.REGISTRY_CONTRACT_ID },
  { contract: 'voucher', contractId: env.VOUCHER_CONTRACT_ID },
  { contract: 'receipt', contractId: env.RECEIPT_CONTRACT_ID },
] as const;

export function contractName(contractId: string): string {
  return CONTRACTS.find((c) => c.contractId === contractId)?.contract ?? 'unknown';
}
