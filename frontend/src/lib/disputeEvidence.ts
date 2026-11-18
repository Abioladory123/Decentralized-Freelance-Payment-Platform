/**
 * disputeEvidence.ts
 *
 * Client-side helpers for dispute attachments (issue #78).
 *
 * The API accepts either an external http(s) URL or the `data:` URL a browser
 * produces for a selected file (the same shape milestone deliverables use).
 * The cap below matches `MAX_EVIDENCE_FILE_BYTES` in the disputes route, so the
 * form rejects an oversized file before reading it and sending several
 * megabytes over the network only to receive a 400.
 */

/** Largest attachment a party may attach to a dispute (2 MiB). */
export const MAX_DISPUTE_EVIDENCE_BYTES = 2 * 1024 * 1024;

/** Read a selected file as a base64 data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
