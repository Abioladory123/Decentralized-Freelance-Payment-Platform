/**
 * Tests for the on-chain arbitrator panel sync (`lib/arbitratorPanel.ts`).
 *
 * The chain read is stubbed; the subject is the resolution order: on-chain
 * panel first, cached for a TTL, stale cache on RPC failure, and the static
 * `ARBITRATOR_ADDRESSES` only when the chain was never readable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";

const OLD = Keypair.random().publicKey();
const ROTATED = Keypair.random().publicKey();
const STATIC = Keypair.random().publicKey();

const h = vi.hoisted(() => ({
  simulate: vi.fn(),
  cfg: {
    DISPUTE_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    ARBITRATOR_ADDRESSES: "",
    ARBITRATOR_PANEL_CACHE_TTL_MS: 30_000,
  },
}));

vi.mock("../config", () => ({ config: h.cfg }));
vi.mock("../lib/soroban", () => ({
  networkPassphrase: "Test SDF Network ; September 2015",
  sorobanServer: { simulateTransaction: h.simulate },
}));

import {
  getArbitratorPanel,
  invalidateArbitratorPanel,
} from "../lib/arbitratorPanel";

function panelResponse(addresses: string[]) {
  return {
    // `isSimulationSuccess` keys on `transactionData`.
    transactionData: {},
    result: {
      retval: nativeToScVal(addresses.map((a) => nativeToScVal(a, { type: "address" }))),
    },
  };
}

beforeEach(() => {
  h.simulate.mockReset();
  h.cfg.DISPUTE_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  h.cfg.ARBITRATOR_ADDRESSES = STATIC;
  h.cfg.ARBITRATOR_PANEL_CACHE_TTL_MS = 30_000;
  invalidateArbitratorPanel();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("getArbitratorPanel", () => {
  it("uses the static list when no dispute contract is configured", async () => {
    h.cfg.DISPUTE_CONTRACT_ID = "";
    expect(await getArbitratorPanel()).toEqual([STATIC]);
    expect(h.simulate).not.toHaveBeenCalled();
  });

  it("reads the panel from the chain, ignoring the static list", async () => {
    h.simulate.mockResolvedValue(panelResponse([OLD]));
    expect(await getArbitratorPanel()).toEqual([OLD]);
  });

  it("reuses the cached panel within the TTL", async () => {
    h.simulate.mockResolvedValue(panelResponse([OLD]));
    await getArbitratorPanel();
    await getArbitratorPanel();
    expect(h.simulate).toHaveBeenCalledTimes(1);
  });

  it("picks up a rotated panel once the cache is dropped", async () => {
    h.simulate.mockResolvedValueOnce(panelResponse([OLD]));
    expect(await getArbitratorPanel()).toEqual([OLD]);
    invalidateArbitratorPanel();
    h.simulate.mockResolvedValueOnce(panelResponse([ROTATED]));
    expect(await getArbitratorPanel()).toEqual([ROTATED]);
  });

  it("serves the last known panel when a refresh fails", async () => {
    h.cfg.ARBITRATOR_PANEL_CACHE_TTL_MS = 0;
    h.simulate.mockResolvedValueOnce(panelResponse([OLD]));
    await getArbitratorPanel();
    h.simulate.mockRejectedValueOnce(new Error("rpc down"));
    expect(await getArbitratorPanel()).toEqual([OLD]);
  });

  it("falls back to the static list when the chain was never readable", async () => {
    h.simulate.mockRejectedValue(new Error("rpc down"));
    expect(await getArbitratorPanel()).toEqual([STATIC]);
  });
});
