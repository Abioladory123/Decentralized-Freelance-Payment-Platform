import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  checkConfiguredContractIds,
  compareContractIds,
  compareContractConfigurationSync,
  describeFreshness,
  describeContractDrift,
  loadDeploymentRecord,
  resolveDeploymentsFile,
  verifyContractConfigurationSync,
  type ConfiguredContractIds,
  type DeploymentRecord,
} from "../lib/contractFreshness";

/**
 * Synthetic ids — never a real deployment. Each is 56 chars starting with `C`
 * so it has the shape of a Soroban contract id, but the bodies are filler.
 */
const ESCROW_OLD = "COLDESCROW" + "A".repeat(46);
const ESCROW_NEW = "CNEWESCROW" + "B".repeat(46);
const DISPUTE = "CDISPUTE" + "C".repeat(48);
const REPUTATION = "CREPUTATION" + "D".repeat(45);

const DEPLOYED: DeploymentRecord = {
  network: "testnet",
  escrow_contract_id: ESCROW_NEW,
  dispute_contract_id: DISPUTE,
  reputation_contract_id: REPUTATION,
};

const MATCHING: ConfiguredContractIds = {
  escrow: ESCROW_NEW,
  dispute: DISPUTE,
  reputation: REPUTATION,
};

describe("compareContractIds", () => {
  it("is fresh when every deployed id is configured and matches", () => {
    expect(compareContractIds(MATCHING, DEPLOYED)).toEqual({ status: "fresh" });
  });

  it("reports a superseded id as stale with both values", () => {
    const freshness = compareContractIds({ ...MATCHING, escrow: ESCROW_OLD }, DEPLOYED);

    expect(freshness.status).toBe("stale");
    if (freshness.status !== "stale") throw new Error("expected stale");
    expect(freshness.mismatches).toEqual([
      { name: "escrow", configured: ESCROW_OLD, deployed: ESCROW_NEW },
    ]);
    expect(freshness.missing).toEqual([]);
  });

  it("flags a contract that is deployed but not configured as missing", () => {
    const freshness = compareContractIds({ ...MATCHING, dispute: "" }, DEPLOYED);

    expect(freshness).toEqual({ status: "stale", mismatches: [], missing: ["dispute"] });
  });

  it("is unconfigured when no ids are set, whatever the record says", () => {
    expect(
      compareContractIds({ escrow: "", dispute: "", reputation: "" }, DEPLOYED),
    ).toEqual({ status: "unconfigured" });
  });

  it("is unverifiable when configured ids exist but the record is missing", () => {
    const freshness = compareContractIds(MATCHING, null);

    expect(freshness).toEqual({ status: "unverifiable", reason: "no deployment record" });
  });

  it("skips a record field that is empty instead of treating it as a mismatch", () => {
    // USDC is recorded as "" until a SAC is configured; that must not read as
    // "the backend is stale".
    expect(compareContractIds(MATCHING, { ...DEPLOYED, escrow_contract_id: "" })).toEqual({
      status: "fresh",
    });
  });
});

describe("describeFreshness", () => {
  it("stays quiet for anything that is not stale", () => {
    expect(describeFreshness({ status: "fresh" })).toBeNull();
    expect(describeFreshness({ status: "unconfigured" })).toBeNull();
    expect(describeFreshness({ status: "unverifiable", reason: "x" })).toBeNull();
  });

  it("names the stale contracts and prints both ids to reconcile", () => {
    const message = describeFreshness(
      compareContractIds({ ...MATCHING, escrow: ESCROW_OLD, reputation: "" }, DEPLOYED),
    );

    expect(message).toContain("[config] Contract IDs do not match the latest deploy");
    expect(message).toContain(`escrow: configured ${ESCROW_OLD}, deployed ${ESCROW_NEW}`);
    expect(message).toContain("reputation: not configured");
  });
});

describe("resolveDeploymentsFile", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contracts-"));
  const override = path.join(dir, "custom.json");
  writeFileSync(override, "{}");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("honours the DEPLOYMENTS_FILE override", () => {
    expect(resolveDeploymentsFile({ DEPLOYMENTS_FILE: override }, dir)).toBe(override);
  });

  it("treats an explicit but missing DEPLOYMENTS_FILE as authoritative", () => {
    // It must not silently fall back to the committed record: the operator asked
    // for a specific file, and comparing against a different one would hide the
    // misconfiguration they are trying to detect.
    expect(
      resolveDeploymentsFile({ DEPLOYMENTS_FILE: path.join(dir, "missing.json") }, dir),
    ).toBeNull();
  });

  it("finds the committed record from the backend package directory", () => {
    const found = resolveDeploymentsFile({}, process.cwd());

    expect(found).not.toBeNull();
    expect(found!.endsWith(path.join("deployments", "testnet.json"))).toBe(true);
  });
});

describe("loadDeploymentRecord", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contracts-record-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses a deploy record", () => {
    const file = path.join(dir, "testnet.json");
    writeFileSync(file, JSON.stringify(DEPLOYED));

    expect(loadDeploymentRecord(file)).toEqual(DEPLOYED);
  });

  it("returns null for invalid JSON, a non-object, or a missing file", () => {
    const invalid = path.join(dir, "invalid.json");
    writeFileSync(invalid, "{ not json");
    const array = path.join(dir, "array.json");
    writeFileSync(array, "[]");

    expect(loadDeploymentRecord(invalid)).toBeNull();
    expect(loadDeploymentRecord(array)).toBeNull();
    expect(loadDeploymentRecord(path.join(dir, "missing.json"))).toBeNull();
  });
});

describe("checkConfiguredContractIds", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "contracts-check-"));
  const file = path.join(dir, "testnet.json");
  writeFileSync(file, JSON.stringify(DEPLOYED));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("warns once when the configured ids are stale", () => {
    const log = vi.fn();

    const freshness = checkConfiguredContractIds(
      { ...MATCHING, escrow: ESCROW_OLD },
      log,
      { DEPLOYMENTS_FILE: file },
      dir,
    );

    expect(freshness.status).toBe("stale");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("superseded contracts");
  });

  it("stays silent when the configured ids match the record", () => {
    const log = vi.fn();

    const freshness = checkConfiguredContractIds(MATCHING, log, { DEPLOYMENTS_FILE: file }, dir);

    expect(freshness).toEqual({ status: "fresh" });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("compareContractConfigurationSync (Issue #316)", () => {
  const ARBITRATOR_1 = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";
  const ARBITRATOR_2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("returns synced when all contract settings match", () => {
    const result = compareContractConfigurationSync(
      {
        escrowContractId: ESCROW_NEW,
        disputeContractId: DISPUTE,
        arbitratorAddresses: [ARBITRATOR_1, ARBITRATOR_2],
        disputeTimeoutSeconds: 604800,
        disputeThreshold: 2,
      },
      {
        escrowDisputeContract: DISPUTE,
        escrowDisputeTimeoutSeconds: 604800n,
        disputeArbitrators: [ARBITRATOR_2, ARBITRATOR_1], // order independent
        disputeThreshold: 2,
      },
    );

    expect(result).toEqual({ status: "synced" });
  });

  it("detects drift when EscrowContract.dispute_contract points to a different address than DISPUTE_CONTRACT_ID", () => {
    const WRONG_DISPUTE = "CWRONGDISPUTE" + "E".repeat(43);
    const result = compareContractConfigurationSync(
      {
        escrowContractId: ESCROW_NEW,
        disputeContractId: DISPUTE,
      },
      {
        escrowDisputeContract: WRONG_DISPUTE,
      },
    );

    expect(result.status).toBe("drifted");
    if (result.status !== "drifted") throw new Error("expected drifted");
    expect(result.mismatches).toEqual([
      {
        field: "escrow_dispute_contract",
        expected: DISPUTE,
        actual: WRONG_DISPUTE,
      },
    ]);
  });

  it("detects drift when dispute arbitrators diverge", () => {
    const result = compareContractConfigurationSync(
      {
        disputeContractId: DISPUTE,
        arbitratorAddresses: [ARBITRATOR_1],
      },
      {
        disputeArbitrators: [ARBITRATOR_2],
      },
    );

    expect(result.status).toBe("drifted");
    if (result.status !== "drifted") throw new Error("expected drifted");
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].field).toBe("dispute_arbitrators");
  });

  it("detects drift when dispute timeout or threshold diverge", () => {
    const result = compareContractConfigurationSync(
      {
        escrowContractId: ESCROW_NEW,
        disputeContractId: DISPUTE,
        disputeTimeoutSeconds: 86400,
        disputeThreshold: 3,
      },
      {
        escrowDisputeContract: DISPUTE,
        escrowDisputeTimeoutSeconds: 604800n,
        disputeThreshold: 1,
      },
    );

    expect(result.status).toBe("drifted");
    if (result.status !== "drifted") throw new Error("expected drifted");
    expect(result.mismatches).toEqual([
      {
        field: "dispute_timeout_seconds",
        expected: "86400",
        actual: "604800",
      },
      {
        field: "dispute_threshold",
        expected: "3",
        actual: "1",
      },
    ]);
  });

  it("returns unconfigured when no contracts are configured", () => {
    const result = compareContractConfigurationSync({}, {});
    expect(result).toEqual({ status: "unconfigured" });
  });
});

describe("describeContractDrift", () => {
  it("returns null when status is not drifted", () => {
    expect(describeContractDrift({ status: "synced" })).toBeNull();
    expect(describeContractDrift({ status: "unconfigured" })).toBeNull();
  });

  it("formats a clear critical warning message containing the mismatched fields", () => {
    const message = describeContractDrift({
      status: "drifted",
      mismatches: [
        {
          field: "escrow_dispute_contract",
          expected: "EXPECTED_ADDR",
          actual: "ACTUAL_ADDR",
        },
      ],
    });

    expect(message).toContain("[config] Critical contract configuration drift detected");
    expect(message).toContain('escrow_dispute_contract: expected "EXPECTED_ADDR", but on-chain state is "ACTUAL_ADDR"');
  });
});

describe("verifyContractConfigurationSync", () => {
  it("invokes contract view readers and returns synced when on-chain state matches", async () => {
    const mockReader = vi.fn().mockImplementation(async (contractId: string, method: string) => {
      if (contractId === ESCROW_NEW && method === "dispute_contract") return DISPUTE;
      if (contractId === ESCROW_NEW && method === "dispute_timeout_seconds") return 604800n;
      if (contractId === DISPUTE && method === "arbitrators") return ["GADMIN"];
      if (contractId === DISPUTE && method === "threshold") return 1;
      return undefined;
    });

    const log = vi.fn();
    const result = await verifyContractConfigurationSync({
      escrowContractId: ESCROW_NEW,
      disputeContractId: DISPUTE,
      arbitratorAddresses: ["GADMIN"],
      disputeTimeoutSeconds: 604800,
      disputeThreshold: 1,
      readView: mockReader,
      log,
    });

    expect(result).toEqual({ status: "synced" });
    expect(log).not.toHaveBeenCalled();
    expect(mockReader).toHaveBeenCalledWith(ESCROW_NEW, "dispute_contract");
  });

  it("warns loudly and returns drifted when on-chain dispute contract link mismatches", async () => {
    const mockReader = vi.fn().mockImplementation(async (contractId: string, method: string) => {
      if (contractId === ESCROW_NEW && method === "dispute_contract") return "COTHERDISPUTE";
      return undefined;
    });

    const log = vi.fn();
    const result = await verifyContractConfigurationSync({
      escrowContractId: ESCROW_NEW,
      disputeContractId: DISPUTE,
      readView: mockReader,
      log,
    });

    expect(result.status).toBe("drifted");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("Critical contract configuration drift detected");
  });

  it("handles reader exceptions gracefully and returns unverifiable", async () => {
    const mockReader = vi.fn().mockRejectedValue(new Error("RPC timeout"));
    const log = vi.fn();

    const result = await verifyContractConfigurationSync({
      escrowContractId: ESCROW_NEW,
      disputeContractId: DISPUTE,
      readView: mockReader,
      log,
    });

    expect(result.status).toBe("unverifiable");
    if (result.status !== "unverifiable") throw new Error("expected unverifiable");
    expect(result.reason).toContain("RPC timeout");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not verify on-chain contract sync"));
  });

  it("returns unconfigured without calling reader if contract IDs are empty", async () => {
    const mockReader = vi.fn();
    const result = await verifyContractConfigurationSync({
      escrowContractId: "",
      disputeContractId: "",
      readView: mockReader,
    });

    expect(result).toEqual({ status: "unconfigured" });
    expect(mockReader).not.toHaveBeenCalled();
  });
});
