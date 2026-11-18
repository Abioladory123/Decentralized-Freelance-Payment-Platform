/**
 * invite.ts
 *
 * Freelancer invite links (issue #80).
 *
 * A client would otherwise retype a freelancer's 56-character Stellar address
 * every time they post a job for them. Instead, the freelancer's profile offers
 * an invite link that opens the job form with `?freelancer=<address>`, so the
 * address is pre-filled and cannot be mistyped.
 *
 * The link is deliberately stateless: a Stellar address is public, so there is
 * nothing to sign or store on the server. The address is validated on both ends
 * — when the link is built and again when it is read back — because a URL is
 * user-editable input.
 */

import { isValidStellarAddress } from "./address";

/** Query parameter that carries the freelancer address into the job form. */
export const FREELANCER_INVITE_PARAM = "freelancer";

/**
 * App-relative invite path, e.g. `/post?freelancer=G...`.
 *
 * Throws on an invalid address rather than producing a link that would be
 * silently ignored when opened.
 */
export function invitePath(freelancerAddress: string): string {
  const address = freelancerAddress.trim();
  if (!isValidStellarAddress(address)) {
    throw new Error(
      "Invalid Stellar address — expected a 56-character G... account id",
    );
  }
  return `/post?${FREELANCER_INVITE_PARAM}=${encodeURIComponent(address)}`;
}

/**
 * Absolute invite link, ready to copy and share.
 *
 * `origin` is injectable so the value is deterministic in tests; in the browser
 * it defaults to the current origin so the link works on whatever host the app
 * is served from.
 */
export function buildInviteLink(freelancerAddress: string, origin?: string): string {
  const base =
    origin ?? (typeof window === "undefined" ? "" : window.location.origin);
  return `${base}${invitePath(freelancerAddress)}`;
}

/**
 * The freelancer address carried by an invite link, or `null` when the query
 * string has no such parameter or its value is not a valid account id.
 *
 * Invalid values are ignored rather than surfaced: the job form stays usable and
 * the client can still type or paste an address by hand.
 */
export function freelancerFromInvite(search: string): string | null {
  const raw = new URLSearchParams(search).get(FREELANCER_INVITE_PARAM);
  const address = raw?.trim() ?? "";
  return isValidStellarAddress(address) ? address : null;
}
