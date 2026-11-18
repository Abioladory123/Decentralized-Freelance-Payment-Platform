import type { Page } from "@playwright/test";

export interface MockFreighterOptions {
  publicKey?: string;
  network?: string;
  networkPassphrase?: string;
}

export const TEST_CLIENT_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const TEST_FREELANCER_KEY = "GCZJ4V5SVDJ6M4SXYVUXR4Q54DYZCVZOHV6NXXK6ZLZWCVJ5N4FXQ4YQ";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Injects a mock Freighter wallet API (window.freighter and window.freighterApi)
 * into the browser page before any page scripts run.
 */
export async function injectMockFreighter(page: Page, options?: MockFreighterOptions) {
  const defaultKey = options?.publicKey ?? TEST_CLIENT_KEY;
  const defaultNetwork = options?.network ?? "TESTNET";
  const defaultPassphrase = options?.networkPassphrase ?? TESTNET_PASSPHRASE;

  await page.addInitScript(
    ({ clientKey, network, passphrase }) => {
      let activeKey = clientKey;
      const activeNetwork = network;
      const activePassphrase = passphrase;
      let connected = false;

      const mockFreighter = {
        isConnected: async () => connected,
        isAllowed: async () => connected,
        setAllowed: async () => {
          connected = true;
          return true;
        },
        getPublicKey: async () => {
          connected = true;
          return activeKey;
        },
        getNetwork: async () => ({
          network: activeNetwork,
          networkPassphrase: activePassphrase,
        }),
        getNetworkDetails: async () => ({
          network: activeNetwork,
          networkPassphrase: activePassphrase,
          networkUrl: "https://soroban-testnet.stellar.org",
        }),
        signTransaction: async (xdr: string) => {
          return xdr;
        },
        signMessage: async () => {
          return { signature: "mock-sep53-signature-base64" };
        },
        // Helper methods for tests to manipulate wallet state
        _switchAccount: (newKey: string) => {
          activeKey = newKey;
        },
        _disconnect: () => {
          connected = false;
        },
        _connect: (key?: string) => {
          connected = true;
          if (key) activeKey = key;
        },
      };

      const win = window as unknown as Record<string, unknown>;
      win.freighter = mockFreighter;
      win.freighterApi = mockFreighter;
    },
    {
      clientKey: defaultKey,
      network: defaultNetwork,
      passphrase: defaultPassphrase,
    }
  );
}

/**
 * Switch active account in the mock Freighter wallet
 */
export async function switchFreighterAccount(page: Page, newPublicKey: string) {
  await page.evaluate((key) => {
    const win = window as unknown as Record<string, { _switchAccount?: (k: string) => void }>;
    win.freighter?._switchAccount?.(key);
    win.freighterApi?._switchAccount?.(key);
  }, newPublicKey);
}
