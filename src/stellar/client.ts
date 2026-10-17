import { Address, Contract, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import pino from 'pino';

import { env, RPC_URLS } from '../env.js';
import { FailoverRpcServer, RpcPool } from './rpc-pool.js';

/**
 * The pool logs endpoint switches, which matter whichever process hit them,
 * so it gets its own logger rather than the request or indexer logger.
 */
const log = pino({ level: env.LOG_LEVEL, name: 'soroban-rpc' });

export const pool = new RpcPool(RPC_URLS, {
  maxFailures: env.SOROBAN_RPC_MAX_FAILURES,
  log,
});

/**
 * Every Soroban read in this service goes through here. It is an
 * `rpc.Server` in all but type: calls are routed to whichever configured
 * endpoint is healthy (see `rpc-pool.ts`).
 */
export const server = new FailoverRpcServer(pool);

/**
 * Reads a contract view function without submitting a transaction.
 *
 * Soroban simulation lets a read run against the current ledger for free.
 * Every read path in this service goes through here; nothing in the backend
 * ever holds a key or signs anything. Writes are built and signed in the
 * user's browser wallet, never here.
 */
export async function readContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const contract = new Contract(contractId);
  const account = new (await import('@stellar/stellar-sdk')).Account(
    // A well-formed but unfunded address is sufficient for simulation.
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    '0',
  );
  const { TransactionBuilder, BASE_FEE } = await import('@stellar/stellar-sdk');

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: env.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractReadError(contractId, method, sim.error);
  }
  if (!sim.result?.retval) {
    throw new ContractReadError(contractId, method, 'simulation returned no value');
  }
  return scValToNative(sim.result.retval) as T;
}

export class ContractReadError extends Error {
  constructor(
    readonly contractId: string,
    readonly method: string,
    readonly detail: string,
  ) {
    super(`Contract read failed: ${method} on ${contractId}: ${detail}`);
    this.name = 'ContractReadError';
  }
}

export function addressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

export async function latestLedger(): Promise<number> {
  const info = await server.getLatestLedger();
  return info.sequence;
}
