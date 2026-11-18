/**
 * address.ts
 *
 * Display and validation helpers for Stellar addresses.
 *
 * A full address is 56 characters, so a list or a nav bar shows a shortened
 * form and keeps the full value in the `title` attribute (and behind the copy
 * button). Every abbreviation in the app goes through here so the two ends are
 * cut consistently.
 *
 * `isValidStellarAddress` mirrors the backend predicate
 * (`backend/src/lib/stellarAddress.ts`): a 'G' strkey of the right shape whose
 * CRC16 checksum verifies. It is what guards values arriving from a URL — an
 * invite link, for instance — before they are shown as a real address.
 */

import { StrKey } from "@stellar/stellar-sdk";

/** Shape of an account strkey: version byte 'G' + 55 base32 characters. */
const ACCOUNT_STRKEY = /^G[A-Z2-7]{55}$/;

/** True when `address` is a checksum-valid Stellar account id. */
export function isValidStellarAddress(address: string): boolean {
  if (!ACCOUNT_STRKEY.test(address)) return false;
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * `GABC…WXYZ` — enough to compare two addresses by eye without wrapping a line.
 *
 * An address shorter than the two ends combined is returned unchanged: a
 * truncated fragment of a malformed value would be more confusing than the
 * value itself.
 */
export function shortAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
