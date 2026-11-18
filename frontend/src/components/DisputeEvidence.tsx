/**
 * DisputeEvidence.tsx
 *
 * Shows the notes and attachments recorded on a dispute and lets a party add
 * more while the dispute is still RAISED — that is, before arbitration begins
 * (issue #78). The API restricts reads to the job's two parties and configured
 * arbitrators; this view is rendered for a participant who has connected a
 * wallet, and the panel reads the same endpoint through its own tooling.
 *
 * Contributor Notes:
 * - The dispute id is the off-chain row id, resolved by `JobDetail` from
 *   `GET /api/jobs/:id`, not the on-chain dispute id.
 * - Attachments follow the deliverable pattern: the browser reads the file as a
 *   data URL and the API stores it, capped at 2 MiB in both places. A deployment
 *   with object storage should replace `fileUrl` with the uploaded object's URL.
 * - Evidence requests need a bearer token, so the list is loaded after wallet
 *   authentication rather than on page mount.
 * - The record closes when arbitration starts (`UNDER_REVIEW`): the form is
 *   replaced by a locked notice instead of letting a submission 409.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../hooks/wallet-context";
import {
  addDisputeEvidence,
  authenticate,
  fetchDisputeEvidence,
  type AddDisputeEvidenceInput,
  type DisputeEvidenceApi,
} from "../lib/api";
import { shortAddress } from "../lib/address";
import {
  MAX_DISPUTE_EVIDENCE_BYTES,
  readFileAsDataUrl,
} from "../lib/disputeEvidence";
import { formatDate } from "../lib/time";

/** Statuses in which the dispute record is still open for submissions. */
const OPEN_STATUS = "RAISED";

export default function DisputeEvidence({
  disputeId,
  status,
}: {
  /** Off-chain dispute id (the row the API scopes evidence to). */
  disputeId: string;
  /** The dispute's current status, e.g. `RAISED` or `UNDER_REVIEW`. */
  status: string;
}) {
  const { publicKey, connect, signMessage } = useWallet();
  const [evidence, setEvidence] = useState<DisputeEvidenceApi[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const isOpen = status === OPEN_STATUS;

  const load = useCallback(async () => {
    if (!publicKey) return;
    setLoadError(null);
    try {
      const token = await authenticate(publicKey, signMessage);
      setEvidence(await fetchDisputeEvidence(disputeId, token));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load dispute evidence",
      );
    }
  }, [disputeId, publicKey, signMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleFileChange(selected: File | null) {
    setSubmitError(null);
    setFileError(null);
    if (!selected) {
      setFile(null);
      return;
    }
    if (selected.size > MAX_DISPUTE_EVIDENCE_BYTES) {
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      setFileError("Attachments must be 2 MB or smaller.");
      return;
    }
    setFile(selected);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!publicKey) {
      await connect();
      return;
    }
    const text = note.trim();
    if (!text && !file) {
      setSubmitError("Add a note or choose a file.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const token = await authenticate(publicKey, signMessage);

      const input: AddDisputeEvidenceInput = {};
      if (text) input.note = text;
      if (file) {
        if (file.size > MAX_DISPUTE_EVIDENCE_BYTES) {
          throw new Error("Attachments must be 2 MB or smaller.");
        }
        input.fileName = file.name;
        input.fileUrl = await readFileAsDataUrl(file);
        input.fileSize = file.size;
        if (file.type) input.fileType = file.type;
      }

      const created = await addDisputeEvidence(disputeId, input, token);
      setEvidence((prev) => [...(prev ?? []), created]);
      setNote("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Could not submit the evidence",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="dispute-evidence-heading" className="dispute-evidence">
      <h2 id="dispute-evidence-heading">Dispute evidence</h2>
      <p className="muted">
        Notes and files the client and freelancer submitted. Visible to both
        parties and the arbitration panel.
      </p>

      {!publicKey ? (
        <p>
          <button type="button" onClick={() => void connect()}>
            Connect a wallet
          </button>{" "}
          to view or add evidence.
        </p>
      ) : (
        <>
          {evidence === null && !loadError && (
            <p role="status" className="muted">
              Loading evidence…
            </p>
          )}
          {loadError && (
            <p role="alert" className="alert alert-error">
              {loadError}
            </p>
          )}
          {evidence !== null && evidence.length === 0 && (
            <p className="muted">No evidence submitted yet.</p>
          )}
          {evidence !== null && evidence.length > 0 && (
            <ul className="evidence-list">
              {evidence.map((entry) => (
                <li key={entry.id}>
                  <p className="muted">
                    <strong>{entry.author?.displayName ?? "Party"}</strong>{" "}
                    <code title={entry.author?.stellarAddress}>
                      {shortAddress(entry.author?.stellarAddress ?? "")}
                    </code>{" "}
                    · <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                  </p>
                  {entry.note && <p>{entry.note}</p>}
                  {entry.fileName && entry.fileUrl && (
                    <p>
                      <a
                        href={entry.fileUrl}
                        download={entry.fileName}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {entry.fileName}
                      </a>
                      {entry.fileSize ? ` (${Math.ceil(entry.fileSize / 1024)} KB)` : ""}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isOpen ? (
            <form onSubmit={handleSubmit}>
              <h3>Add evidence</h3>
              <p>
                <label htmlFor="dispute-evidence-note">
                  Note
                  <textarea
                    id="dispute-evidence-note"
                    className="form-control"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={2000}
                    rows={3}
                    placeholder="What should the panel know?"
                  />
                </label>
              </p>
              <p>
                <label htmlFor="dispute-evidence-file">
                  Attachment (optional, max 2 MB)
                  <input
                    id="dispute-evidence-file"
                    ref={fileInput}
                    type="file"
                    onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
                  />
                </label>
              </p>
              {fileError && (
                <p role="alert" className="alert alert-error">
                  {fileError}
                </p>
              )}
              {submitError && (
                <p role="alert" className="alert alert-error">
                  {submitError}
                </p>
              )}
              <button
                type="submit"
                className="btn-primary"
                disabled={submitting || (!note.trim() && !file)}
                aria-busy={submitting}
              >
                {submitting ? "Submitting…" : "Submit evidence"}
              </button>
            </form>
          ) : (
            <p className="muted" role="status">
              Evidence is locked: the dispute is {status.toLowerCase().replace(/_/g, " ")}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
