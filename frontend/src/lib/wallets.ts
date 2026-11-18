/**
 * wallets.ts
 *
 * Wallet adapter registry. Each supported browser wallet exposes its own API
 * shape, so this module normalises them behind one small interface that the
 * React layer (`hooks/WalletProvider.tsx`) can drive:
 *
 *   isAvailable() → connect() → signTransaction() / signMessage()
 *
 * Supported providers:
 * - Freighter: injected into the page as `window.freighterApi` (current) or
 *   `window.freighter` (legacy).
 * - LOBSTR: the official `@lobstrco/signer-extension-api` package, which talks
 *   to the LOBSTR Signer Extension over `postMessage`.
 *
 * Adding a wallet means implementing `WalletAdapter` and appending it to
 * `WALLETS`; the picker and the provider pick it up automatically.
 *
 * No private keys ever touch this code; each wallet signs in its own context.
 * All message signing is SEP-53, so the backend can verify it the same way for
 * every provider.
 */

import {
  getPublicKey as lobstrGetPublicKey,
  isConnected as lobstrIsConnected,
  signMessage as lobstrSignMessage,
  signTransaction as lobstrSignTransaction,
} from "@lobstrco/signer-extension-api";

export type WalletId = "freighter" | "lobstr";

export interface SignTransactionOptions {
  networkPassphrase: string;
  /** Ask the wallet to sign with a specific account, when it supports that. */
  address?: string;
}

export interface WalletAdapter {
  id: WalletId;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Where to install the wallet when it is not detected. */
  installUrl: string;
  /** Is the wallet installed/available in this browser right now? */
  isAvailable(): Promise<boolean>;
  /** Request access and return the user's public key. */
  connect(): Promise<string>;
  /** Sign an assembled transaction XDR and return the signed XDR. */
  signTransaction(xdr: string, opts: SignTransactionOptions): Promise<string>;
  /** Sign a message per SEP-53 and return the base64 signature. */
  signMessage?(message: string, address?: string): Promise<string>;
  /** Passphrase of the network the wallet is configured for, when exposed. */
  getNetwork?(): Promise<string>;
}

export interface DetectedWallet {
  adapter: WalletAdapter;
  available: boolean;
}

// ---------------------------------------------------------------------------
// Freighter (browser extension)
// ---------------------------------------------------------------------------

export interface FreighterApi {
  getPublicKey(): Promise<string>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<string | { signedTxXdr: string }>;
  /** SEP-53 message signing. Newer versions return an object, older a string. */
  signMessage?(
    message: string,
    opts?: { address?: string },
  ): Promise<{ signature: string } | string>;
  /** The network the extension is currently set to. */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

declare global {
  interface Window {
    freighter?: FreighterApi;
    freighterApi?: FreighterApi;
  }
}

export function freighter(): FreighterApi | undefined {
  if (typeof window === "undefined") return undefined;
  return window.freighterApi ?? window.freighter;
}

function requireFreighter(): FreighterApi {
  const api = freighter();
  if (!api) throw new Error("Freighter is not installed. Install it from freighter.app");
  return api;
}

export const freighterAdapter: WalletAdapter = {
  id: "freighter",
  name: "Freighter",
  installUrl: "https://www.freighter.app/",
  isAvailable: async () => freighter() !== undefined,
  async connect() {
    return requireFreighter().getPublicKey();
  },
  async signTransaction(xdr, opts) {
    const result = await requireFreighter().signTransaction(xdr, {
      networkPassphrase: opts.networkPassphrase,
      address: opts.address,
    });
    return typeof result === "string" ? result : result.signedTxXdr;
  },
  async signMessage(message, address) {
    const api = requireFreighter();
    if (!api.signMessage) {
      throw new Error("This Freighter version can't sign messages; update the extension.");
    }
    const result = await api.signMessage(message, address ? { address } : undefined);
    return typeof result === "string" ? result : result.signature;
  },
  async getNetwork() {
    const api = requireFreighter();
    if (!api.getNetwork) {
      throw new Error("This Freighter version can't report its network");
    }
    return (await api.getNetwork()).networkPassphrase;
  },
};

// ---------------------------------------------------------------------------
// LOBSTR (signer extension)
// ---------------------------------------------------------------------------

/** LOBSTR returns an empty string when the user rejects a signature request. */
const rejected = (action: string): Error =>
  new Error(`LOBSTR rejected the ${action} request.`);

export const lobstrAdapter: WalletAdapter = {
  id: "lobstr",
  name: "LOBSTR",
  installUrl: "https://lobstr.co/signer-extension/",
  async isAvailable() {
    try {
      return await lobstrIsConnected();
    } catch {
      // A missing extension never answers the probe; treat any failure as absent.
      return false;
    }
  },
  async connect() {
    // A missing extension rejects the probe or never answers it; both mean the
    // wallet is unavailable, never a transport error the user can act on.
    const available = await lobstrIsConnected().catch(() => false);
    if (!available) {
      throw new Error(
        "LOBSTR Signer Extension is not installed. Install it from lobstr.co/signer-extension",
      );
    }
    return lobstrGetPublicKey();
  },
  async signTransaction(xdr) {
    // The network passphrase is already part of the transaction hash, and the
    // extension signs for the account the user picked (Stellar by default).
    const signed = await lobstrSignTransaction(xdr);
    if (!signed) throw rejected("transaction");
    return signed;
  },
  async signMessage(message) {
    const result = await lobstrSignMessage(message);
    if (!result) throw rejected("message signing");
    return result.signedMessage;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every wallet the app can connect, in picker order. */
export const WALLETS: readonly WalletAdapter[] = [
  freighterAdapter,
  lobstrAdapter,
];

export function getWallet(id: WalletId): WalletAdapter | undefined {
  return WALLETS.find((wallet) => wallet.id === id);
}

/** Probe every wallet in parallel; the picker shows which ones are installed. */
export async function detectWallets(): Promise<DetectedWallet[]> {
  return Promise.all(
    WALLETS.map(async (adapter) => ({
      adapter,
      available: await adapter.isAvailable(),
    })),
  );
}
