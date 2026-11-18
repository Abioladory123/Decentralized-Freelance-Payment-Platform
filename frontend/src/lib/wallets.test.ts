import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below can reference them.
const h = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  isConnected: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@lobstrco/signer-extension-api", () => ({
  getPublicKey: h.getPublicKey,
  isConnected: h.isConnected,
  signMessage: h.signMessage,
  signTransaction: h.signTransaction,
}));

import {
  detectWallets,
  freighterAdapter,
  lobstrAdapter,
} from "./wallets";

const PASSPHRASE = "Test SDF Network ; September 2015";

/** Install a fake Freighter API on the page. */
function injectFreighter(api: Record<string, unknown>): void {
  (window as unknown as { freighterApi?: unknown }).freighterApi = api;
}

beforeEach(() => {
  delete (window as unknown as { freighterApi?: unknown }).freighterApi;
  delete (window as unknown as { freighter?: unknown }).freighter;
  h.getPublicKey.mockReset();
  h.isConnected.mockReset();
  h.signMessage.mockReset();
  h.signTransaction.mockReset();
});

afterEach(() => {
  delete (window as unknown as { freighterApi?: unknown }).freighterApi;
  delete (window as unknown as { freighter?: unknown }).freighter;
});

describe("Freighter adapter", () => {
  it("is unavailable until the extension injects its API", async () => {
    expect(await freighterAdapter.isAvailable()).toBe(false);
    await expect(freighterAdapter.connect()).rejects.toThrow(/not installed/);
  });

  it("connects through the injected API", async () => {
    injectFreighter({ getPublicKey: vi.fn(async () => "GFREIGHTER") });

    expect(await freighterAdapter.isAvailable()).toBe(true);
    await expect(freighterAdapter.connect()).resolves.toBe("GFREIGHTER");
  });

  it("normalises the signed XDR and passes the network passphrase", async () => {
    const signTransaction = vi.fn(async () => ({ signedTxXdr: "SIGNED" }));
    injectFreighter({ getPublicKey: vi.fn(), signTransaction });

    await expect(
      freighterAdapter.signTransaction("UNSIGNED", {
        networkPassphrase: PASSPHRASE,
        address: "GFREIGHTER",
      }),
    ).resolves.toBe("SIGNED");
    expect(signTransaction).toHaveBeenCalledWith("UNSIGNED", {
      networkPassphrase: PASSPHRASE,
      address: "GFREIGHTER",
    });
  });

  it("accepts the legacy string result for both signing methods", async () => {
    injectFreighter({
      getPublicKey: vi.fn(),
      signTransaction: vi.fn(async () => "SIGNED"),
      signMessage: vi.fn(async () => "SIG"),
    });

    await expect(
      freighterAdapter.signTransaction("UNSIGNED", { networkPassphrase: PASSPHRASE }),
    ).resolves.toBe("SIGNED");
    await expect(freighterAdapter.signMessage?.("hello")).resolves.toBe("SIG");
  });

  it("explains when the installed Freighter cannot sign messages", async () => {
    injectFreighter({ getPublicKey: vi.fn() });

    await expect(freighterAdapter.signMessage?.("hello")).rejects.toThrow(
      /can't sign messages/,
    );
  });

  it("reports its configured network passphrase", async () => {
    injectFreighter({
      getPublicKey: vi.fn(),
      getNetwork: vi.fn(async () => ({
        network: "TESTNET",
        networkPassphrase: PASSPHRASE,
      })),
    });

    await expect(freighterAdapter.getNetwork?.()).resolves.toBe(PASSPHRASE);
  });
});

describe("LOBSTR adapter", () => {
  it("reports absence when the extension does not answer", async () => {
    h.isConnected.mockRejectedValue(new Error("no extension"));

    expect(await lobstrAdapter.isAvailable()).toBe(false);
    await expect(lobstrAdapter.connect()).rejects.toThrow(/not installed/);
  });

  it("connects once the extension is available", async () => {
    h.isConnected.mockResolvedValue(true);
    h.getPublicKey.mockResolvedValue("GLOBSTR");

    expect(await lobstrAdapter.isAvailable()).toBe(true);
    await expect(lobstrAdapter.connect()).resolves.toBe("GLOBSTR");
  });

  it("surfaces a rejection instead of returning an empty XDR", async () => {
    h.signTransaction.mockResolvedValue("");

    await expect(
      lobstrAdapter.signTransaction("UNSIGNED", { networkPassphrase: PASSPHRASE }),
    ).rejects.toThrow(/rejected/);
  });

  it("returns the signed transaction XDR", async () => {
    h.signTransaction.mockResolvedValue("SIGNED");

    await expect(
      lobstrAdapter.signTransaction("UNSIGNED", { networkPassphrase: PASSPHRASE }),
    ).resolves.toBe("SIGNED");
  });

  it("unwraps the SEP-53 message signature", async () => {
    h.signMessage.mockResolvedValue({
      signedMessage: "SIG",
      signerAddress: "GLOBSTR",
    });

    await expect(lobstrAdapter.signMessage?.("hello")).resolves.toBe("SIG");
  });

  it("throws when the message signing request is rejected", async () => {
    h.signMessage.mockResolvedValue(null);

    await expect(lobstrAdapter.signMessage?.("hello")).rejects.toThrow(/rejected/);
  });
});

describe("detectWallets", () => {
  it("probes every registered wallet", async () => {
    h.isConnected.mockResolvedValue(false);
    delete (window as unknown as { freighterApi?: unknown }).freighterApi;

    const detected = await detectWallets();

    expect(detected.map((w) => w.adapter.id)).toEqual(["freighter", "lobstr"]);
    expect(detected.find((w) => w.adapter.id === "freighter")?.available).toBe(false);
    expect(detected.find((w) => w.adapter.id === "lobstr")?.available).toBe(false);
  });

  it("marks an injected wallet as available", async () => {
    injectFreighter({ getPublicKey: vi.fn() });
    h.isConnected.mockResolvedValue(true);

    const detected = await detectWallets();

    expect(detected.every((w) => w.available)).toBe(true);
  });
});
