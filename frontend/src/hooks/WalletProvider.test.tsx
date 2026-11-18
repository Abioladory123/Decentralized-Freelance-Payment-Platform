import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WalletProvider } from "./WalletProvider";
import { useWallet } from "./wallet-context";

// Hoisted so the vi.mock factory below can reference them.
const h = vi.hoisted(() => {
  const freighter = {
    id: "freighter",
    name: "Freighter",
    installUrl: "https://www.freighter.app/",
    isAvailable: vi.fn(async () => true),
    connect: vi.fn(async () => "GFREIGHTER"),
    signTransaction: vi.fn(async () => "SIGNED-XDR"),
    signMessage: vi.fn(async () => "SIGNED-MESSAGE"),
  };
  const lobstr = {
    id: "lobstr",
    name: "LOBSTR",
    installUrl: "https://lobstr.co/signer-extension/",
    isAvailable: vi.fn(async () => false),
    connect: vi.fn(async () => "GLOBSTR"),
    signTransaction: vi.fn(async () => "LOBSTR-XDR"),
    signMessage: vi.fn(async () => "LOBSTR-MESSAGE"),
  };
  return { freighter, lobstr, wallets: [freighter, lobstr] };
});

vi.mock("../lib/stellar", () => ({
  networkPassphrase: "Test SDF Network ; September 2015",
}));

vi.mock("../lib/wallets", () => ({
  getWallet: (id: string) => h.wallets.find((wallet) => wallet.id === id),
  detectWallets: async () =>
    Promise.all(
      h.wallets.map(async (adapter) => ({
        adapter,
        available: await adapter.isAvailable(),
      })),
    ),
}));

/** Small consumer that exposes context state and actions as buttons. */
function Harness() {
  const { publicKey, connecting, walletId, connect, sign, signMessage, error } =
    useWallet();
  return (
    <div>
      <p>account:{publicKey ?? "none"}</p>
      <p>wallet:{walletId ?? "none"}</p>
      <p>connecting:{connecting ? "yes" : "no"}</p>
      <p>error:{error ?? "none"}</p>
      <button onClick={() => void connect()}>open picker</button>
      <button onClick={() => void connect("freighter")}>connect freighter</button>
      <button onClick={() => void sign("UNSIGNED").then((x) => alert(x), () => {})}>
        sign
      </button>
      <button onClick={() => void signMessage("hello").then((x) => alert(x), () => {})}>
        sign message
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <WalletProvider>
      <Harness />
    </WalletProvider>,
  );
}

beforeEach(() => {
  h.freighter.isAvailable.mockReset();
  h.freighter.isAvailable.mockResolvedValue(true);
  h.freighter.connect.mockReset();
  h.freighter.connect.mockResolvedValue("GFREIGHTER");
  h.freighter.signTransaction.mockReset();
  h.freighter.signTransaction.mockResolvedValue("SIGNED-XDR");
  h.freighter.signMessage.mockReset();
  h.freighter.signMessage.mockResolvedValue("SIGNED-MESSAGE");
  h.lobstr.isAvailable.mockReset();
  h.lobstr.isAvailable.mockResolvedValue(false);
});

afterEach(() => cleanup());

describe("WalletProvider", () => {
  it("opens the picker when connecting without a wallet and connects the chosen one", async () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "open picker" }));
    await screen.findByRole("dialog", { name: "Connect a wallet" });

    // The installed wallet is a connect button; the missing one links to install.
    await screen.findByRole("button", { name: "Connect Freighter" });
    expect(screen.getByRole("link", { name: "Install LOBSTR" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Connect Freighter" }));

    await screen.findByText("account:GFREIGHTER");
    expect(screen.getByText("wallet:freighter")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.freighter.connect).toHaveBeenCalledTimes(1);
  });

  it("closes the picker without connecting when dismissed", async () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "open picker" }));
    await screen.findByRole("dialog", { name: "Connect a wallet" });
    fireEvent.click(screen.getByRole("button", { name: "Close wallet picker" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("account:none")).toBeTruthy();
    expect(h.freighter.connect).not.toHaveBeenCalled();
  });

  it("connects a wallet directly when an id is given", async () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "connect freighter" }));

    await screen.findByText("account:GFREIGHTER");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports an install hint when the selected wallet is missing", async () => {
    h.freighter.isAvailable.mockResolvedValue(false);
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "connect freighter" }));

    await screen.findByText(/Freighter is not installed/);
    expect(screen.getByText("account:none")).toBeTruthy();
  });

  it("routes signing through the connected adapter with the network passphrase", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "connect freighter" }));
    await screen.findByText("account:GFREIGHTER");

    fireEvent.click(screen.getByRole("button", { name: "sign" }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("SIGNED-XDR"));
    expect(h.freighter.signTransaction).toHaveBeenCalledWith("UNSIGNED", {
      networkPassphrase: "Test SDF Network ; September 2015",
      address: "GFREIGHTER",
    });

    fireEvent.click(screen.getByRole("button", { name: "sign message" }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("SIGNED-MESSAGE"));
    expect(h.freighter.signMessage).toHaveBeenCalledWith("hello", "GFREIGHTER");
    alertSpy.mockRestore();
  });
});
