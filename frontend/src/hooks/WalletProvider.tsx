/**
 * WalletProvider.tsx
 *
 * Provides the connected wallet state to the app, using the adapters in
 * `lib/wallets.ts`. See `wallet-context.ts` for the context object and the
 * `useWallet` hook.
 *
 * Calling `connect()` without a wallet id opens `WalletPicker` and resolves with
 * the chosen wallet's public key, so every "Connect" button in the app gets the
 * picker for free. Passing an id connects that wallet directly.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { networkPassphrase } from "../lib/stellar";
import { getWallet, type WalletId } from "../lib/wallets";
import { clearAuthToken } from "../lib/api";
import WalletPicker from "../components/WalletPicker";
import { WalletContext } from "./wallet-context";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<WalletId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkMismatch, setNetworkMismatch] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Resolver for the `connect()` call that opened the picker.
  const pickerResolver = useRef<((key: string | null) => void) | null>(null);

  /** Warn when the wallet is configured for a different network than the app. */
  const checkNetworkMatch = useCallback(async (id: WalletId | null) => {
    const adapter = id ? getWallet(id) : undefined;
    if (!adapter?.getNetwork) {
      // Wallets that don't expose their network can't be checked.
      setNetworkMismatch(false);
      return;
    }
    try {
      const walletPassphrase = await adapter.getNetwork();
      setNetworkMismatch(walletPassphrase !== networkPassphrase);
    } catch {
      // If we can't get the network, assume there's no mismatch.
      setNetworkMismatch(false);
    }
  }, []);

  /** Connect a specific wallet adapter and store the resulting account. */
  const connectWallet = useCallback(
    async (id: WalletId): Promise<string | null> => {
      setConnecting(true);
      setError(null);
      try {
        const adapter = getWallet(id);
        if (!adapter) throw new Error(`Unsupported wallet: ${id}`);
        if (!(await adapter.isAvailable())) {
          throw new Error(
            `${adapter.name} is not installed. Install it from ${adapter.installUrl}`,
          );
        }
        const key = await adapter.connect();
        setPublicKey(key);
        setWalletId(id);
        await checkNetworkMatch(id);
        return key;
      } catch (e) {
        setError(errorMessage(e));
        return null;
      } finally {
        setConnecting(false);
      }
    },
    [checkNetworkMatch],
  );

  const connect = useCallback(
    (id?: WalletId): Promise<string | null> => {
      if (id) return connectWallet(id);
      // A previous picker request is superseded by this one.
      pickerResolver.current?.(null);
      setPickerOpen(true);
      return new Promise<string | null>((resolve) => {
        pickerResolver.current = resolve;
      });
    },
    [connectWallet],
  );

  const selectWallet = useCallback(
    (id: WalletId) => {
      const resolve = pickerResolver.current;
      pickerResolver.current = null;
      setPickerOpen(false);
      void connectWallet(id).then((key) => resolve?.(key));
    },
    [connectWallet],
  );

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    const resolve = pickerResolver.current;
    pickerResolver.current = null;
    resolve?.(null);
  }, []);

  const disconnect = useCallback(() => {
    if (publicKey) clearAuthToken(publicKey);
    setPublicKey(null);
    setWalletId(null);
    setError(null);
    setNetworkMismatch(false);
  }, [publicKey]);

  const sign = useCallback(
    async (xdr: string) => {
      const adapter = walletId ? getWallet(walletId) : undefined;
      if (!adapter) throw new Error("Connect a wallet first");
      return adapter.signTransaction(xdr, {
        networkPassphrase,
        address: publicKey ?? undefined,
      });
    },
    [walletId, publicKey],
  );

  const signMessage = useCallback(
    async (message: string) => {
      const adapter = walletId ? getWallet(walletId) : undefined;
      if (!adapter) throw new Error("Connect a wallet first");
      if (!adapter.signMessage) {
        throw new Error(`${adapter.name} can't sign messages`);
      }
      return adapter.signMessage(message, publicKey ?? undefined);
    },
    [walletId, publicKey],
  );

  // Re-check the network when the user switches it in the wallet and comes back.
  useEffect(() => {
    if (!publicKey) return;

    const handleFocus = () => {
      void checkNetworkMatch(walletId);
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [publicKey, walletId, checkNetworkMatch]);

  const value = useMemo(
    () => ({
      publicKey,
      connecting,
      error,
      networkMismatch,
      walletId,
      connect,
      disconnect,
      sign,
      signMessage,
    }),
    [
      publicKey,
      connecting,
      error,
      networkMismatch,
      walletId,
      connect,
      disconnect,
      sign,
      signMessage,
    ],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <WalletPicker open={pickerOpen} onSelect={selectWallet} onClose={closePicker} />
    </WalletContext.Provider>
  );
}
