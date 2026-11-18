/**
 * wallet-context.ts
 *
 * Wallet context object + hook, kept separate from the provider component so
 * Fast Refresh works when editing the provider.
 *
 * The provider can connect any adapter registered in `lib/wallets.ts` (Freighter
 * and LOBSTR today); the context exposes the selected wallet and routes signing
 * through it, so pages never talk to a specific provider API.
 *
 * No private keys ever touch this code; the wallet signs in its own context.
 */

import { createContext, useContext } from "react";
import type { WalletId } from "../lib/wallets";

export interface WalletContextValue {
  publicKey: string | null;
  connecting: boolean;
  error: string | null;
  /** True when the connected wallet is on a different network than the app. */
  networkMismatch: boolean;
  /** Adapter behind the current connection, or `null` when disconnected. */
  walletId: WalletId | null;
  /**
   * Connect a wallet. With an id, connect that wallet directly; without one,
   * open the wallet picker and resolve with the chosen wallet's public key
   * (`null` if the user cancels).
   */
  connect: (walletId?: WalletId) => Promise<string | null>;
  disconnect: () => void;
  sign: (xdr: string) => Promise<string>;
  /** Sign a message per SEP-53; returns the base64 signature. */
  signMessage: (message: string) => Promise<string>;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
