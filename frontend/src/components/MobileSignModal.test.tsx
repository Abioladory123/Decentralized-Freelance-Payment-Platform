import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import MobileSignModal from "./MobileSignModal";
import * as stellar from "../lib/stellar";

vi.mock("../lib/stellar", () => ({
  generateSep0007Uri: (xdr: string) => `web+stellar:tx?xdr=${encodeURIComponent(xdr)}`,
  getTransactionHashFromXdr: () => "mocked-hash-12345",
  pollTransaction: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MobileSignModal (issue #312)", () => {
  it("renders mobile signing modal with SEP-0007 link and QR code", () => {
    vi.mocked(stellar.pollTransaction).mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();

    render(<MobileSignModal xdr="test-unsigned-xdr" onClose={onClose} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Sign on Mobile (SEP-0007)")).toBeTruthy();
    expect(screen.getByLabelText(/QR code for SEP-0007 Transaction Signing QR/i)).toBeTruthy();

    const link = screen.getByRole("link", { name: "Open in Mobile Wallet" }) as HTMLAnchorElement;
    expect(link.href).toBe("web+stellar:tx?xdr=test-unsigned-xdr");
  });

  it("calls onClose when close button is clicked", () => {
    vi.mocked(stellar.pollTransaction).mockImplementation(() => new Promise(() => {}));
    const onClose = vi.fn();

    render(<MobileSignModal xdr="test-unsigned-xdr" onClose={onClose} />);

    const closeBtn = screen.getByRole("button", { name: "Close modal" });
    act(() => {
      closeBtn.click();
    });

    expect(onClose).toHaveBeenCalled();
  });

  it("polls for transaction confirmation and triggers onConfirmed on success", async () => {
    type PollResult = Awaited<ReturnType<typeof stellar.pollTransaction>>;
    let resolvePoll: (val: PollResult) => void = () => {};
    vi.mocked(stellar.pollTransaction).mockImplementation(
      () => new Promise((resolve) => (resolvePoll = resolve)),
    );

    const onConfirmed = vi.fn();
    const onClose = vi.fn();

    render(
      <MobileSignModal
        xdr="test-unsigned-xdr"
        onClose={onClose}
        onConfirmed={onConfirmed}
      />,
    );

    expect(screen.getByText(/Waiting for mobile wallet signature/i)).toBeTruthy();

    act(() => {
      resolvePoll({ status: "SUCCESS" } as PollResult);
    });

    await waitFor(() => {
      expect(screen.getByText(/Transaction confirmed on ledger!/i)).toBeTruthy();
    });

    expect(onConfirmed).toHaveBeenCalledWith("mocked-hash-12345");
  });
});
