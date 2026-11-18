/**
 * DisputeEvidence.test.tsx
 *
 * The panel reads this record, so the pieces that matter are: existing notes
 * and files are shown with their author, a party can submit a note, a selected
 * file is read into the data URL the API accepts, and the form disappears once
 * arbitration starts (#78). Wallet and API are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  wallet: {
    publicKey: "GCLIENT" as string | null,
    connect: vi.fn(async () => "GCLIENT"),
    signMessage: vi.fn(async () => "sig"),
  },
  authenticate: vi.fn(async () => "jwt-1"),
  fetchDisputeEvidence: vi.fn(),
  addDisputeEvidence: vi.fn(),
}));

vi.mock("../hooks/wallet-context", () => ({ useWallet: () => h.wallet }));
vi.mock("../lib/api", () => ({
  authenticate: h.authenticate,
  fetchDisputeEvidence: h.fetchDisputeEvidence,
  addDisputeEvidence: h.addDisputeEvidence,
}));

import DisputeEvidence from "./DisputeEvidence";
import type { DisputeEvidenceApi } from "../lib/api";

const CLIENT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

function evidence(overrides: Partial<DisputeEvidenceApi> = {}): DisputeEvidenceApi {
  return {
    id: "evidence-1",
    disputeId: "dispute-1",
    note: "The signed scope document",
    fileName: null,
    fileUrl: null,
    fileSize: null,
    fileType: null,
    createdAt: "2026-01-02T00:00:00.000Z",
    author: { stellarAddress: CLIENT, displayName: "Client" },
    ...overrides,
  };
}

beforeEach(() => {
  h.wallet.publicKey = CLIENT;
  h.fetchDisputeEvidence.mockReset();
  h.fetchDisputeEvidence.mockResolvedValue([]);
  h.addDisputeEvidence.mockReset();
});

afterEach(() => cleanup());

describe("DisputeEvidence", () => {
  it("lists the notes and files already submitted", async () => {
    h.fetchDisputeEvidence.mockResolvedValue([
      evidence(),
      evidence({
        id: "evidence-2",
        note: null,
        fileName: "handoff.zip",
        fileUrl: "https://example.com/handoff.zip",
        fileSize: 2048,
        author: { stellarAddress: CLIENT, displayName: null },
      }),
    ]);

    render(<DisputeEvidence disputeId="dispute-1" status="RAISED" />);

    expect(await screen.findByText("The signed scope document")).toBeTruthy();
    expect(screen.getByText("Client")).toBeTruthy();
    const link = screen.getByRole("link", { name: "handoff.zip" });
    expect(link.getAttribute("href")).toBe("https://example.com/handoff.zip");
    expect(screen.getByText(/2 KB/)).toBeTruthy();
    expect(h.fetchDisputeEvidence).toHaveBeenCalledWith("dispute-1", "jwt-1");
  });

  it("submits a note as the connected party", async () => {
    h.addDisputeEvidence.mockResolvedValue(evidence({ note: "Signed brief" }));

    render(<DisputeEvidence disputeId="dispute-1" status="RAISED" />);
    await screen.findByText("No evidence submitted yet.");

    fireEvent.change(screen.getByLabelText(/^Note/), {
      target: { value: "Signed brief" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit evidence" }));

    await waitFor(() =>
      expect(h.addDisputeEvidence).toHaveBeenCalledWith(
        "dispute-1",
        { note: "Signed brief" },
        "jwt-1",
      ),
    );
    // The new entry is rendered straight from the response.
    expect(screen.getByText("Signed brief")).toBeTruthy();
  });

  it("reads a chosen file into the data URL the API accepts", async () => {
    h.addDisputeEvidence.mockResolvedValue(
      evidence({ note: null, fileName: "proof.txt", fileUrl: "data:text/plain;base64,aGVsbG8=" }),
    );

    render(<DisputeEvidence disputeId="dispute-1" status="RAISED" />);
    await screen.findByText("No evidence submitted yet.");

    const file = new File(["hello"], "proof.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/Attachment/), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit evidence" }));

    await waitFor(() => expect(h.addDisputeEvidence).toHaveBeenCalled());
    const input = h.addDisputeEvidence.mock.calls[0][1] as {
      fileName: string;
      fileUrl: string;
      fileSize: number;
      fileType: string;
    };
    expect(input.fileName).toBe("proof.txt");
    expect(input.fileUrl.startsWith("data:text/plain")).toBe(true);
    expect(input.fileSize).toBe(5);
    expect(input.fileType).toBe("text/plain");
  });

  it("locks the record once arbitration has started", async () => {
    render(<DisputeEvidence disputeId="dispute-1" status="UNDER_REVIEW" />);

    expect(await screen.findByText(/Evidence is locked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit evidence" })).toBeNull();
  });

  it("asks a visitor without a wallet to connect before loading evidence", async () => {
    h.wallet.publicKey = null;

    render(<DisputeEvidence disputeId="dispute-1" status="RAISED" />);

    expect(
      screen.getByRole("button", { name: "Connect a wallet" }),
    ).toBeTruthy();
    expect(h.fetchDisputeEvidence).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Connect a wallet" }));
    await waitFor(() => expect(h.wallet.connect).toHaveBeenCalled());
  });
});
