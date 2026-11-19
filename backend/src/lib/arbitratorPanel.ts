/**
 * arbitratorPanel.ts
 *
 * The arbitrator panel the API authorizes against, read from the on-chain
 * dispute contract (`arbitrators()` view) instead of a static env var.
 *
 * The contract's admin can rotate the panel with `set_panel`. A list frozen in
 * `ARBITRATOR_ADDRESSES` then drifts from the chain: it blocks new arbitrators
 * and keeps honouring removed ones. The contract is the authority, so the API
 * reads the panel from it and caches the answer briefly (`set_panel` emits no
 * event the indexer could react to, so a short TTL bounds the staleness).
 *
 * Resolution order:
 *   1. no `DISPUTE_CONTRACT_ID` configured → the static `ARBITRATOR_ADDRESSES`;
 *   2. a fresh cached on-chain panel;
 *   3. a successful on-chain read (cached);
 *   4. the last on-chain panel we saw, if the read now fails (stale but real);
 *   5. the static `ARBITRATOR_ADDRESSES`, if the chain has never been readable.
 *
 * An empty result means "nobody", and callers fail closed on it.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import { config } from "../config";
import { parseList } from "./access";
import { networkPassphrase, sorobanServer } from "./soroban";

/** A well-formed account that never signs: simulation of a view needs a source only. */
const SIMULATION_ONLY_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

interface CachedPanel {
  panel: string[];
  fetchedAt: number;
}

let cached: CachedPanel | null = null;
let inFlight: Promise<string[]> | null = null;

/** Read `arbitrators()` from the dispute contract. Throws if it cannot be read. */
export async function fetchOnChainPanel(
  contractId: string = config.DISPUTE_CONTRACT_ID,
): Promise<string[]> {
  const tx = new TransactionBuilder(new Account(SIMULATION_ONLY_SOURCE, "0"), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(new Contract(contractId).call("arbitrators"))
    .setTimeout(30)
    .build();

  const sim = await sorobanServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
    throw new Error("Simulation of dispute.arbitrators() failed");
  }
  const value = scValToNative(sim.result.retval);
  if (!Array.isArray(value)) {
    throw new Error("dispute.arbitrators() did not return a list");
  }
  return value.map((a) => String(a));
}

/** The current arbitrator panel. Never throws; an empty list means nobody. */
export async function getArbitratorPanel(now: number = Date.now()): Promise<string[]> {
  const staticPanel = parseList(config.ARBITRATOR_ADDRESSES);
  if (!config.DISPUTE_CONTRACT_ID) return staticPanel;

  if (cached && now - cached.fetchedAt < config.ARBITRATOR_PANEL_CACHE_TTL_MS) {
    return cached.panel;
  }

  // Share one RPC call between concurrent requests.
  inFlight ??= fetchOnChainPanel()
    .then((panel) => {
      cached = { panel, fetchedAt: Date.now() };
      return panel;
    })
    .catch((err) => {
      console.warn(
        `[arbitrators] could not read the on-chain panel (${
          err instanceof Error ? err.message : String(err)
        }); using ${cached ? "the last known panel" : "ARBITRATOR_ADDRESSES"}`,
      );
      return cached ? cached.panel : staticPanel;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Drop the cached panel so the next check re-reads the chain. */
export function invalidateArbitratorPanel(): void {
  cached = null;
}
