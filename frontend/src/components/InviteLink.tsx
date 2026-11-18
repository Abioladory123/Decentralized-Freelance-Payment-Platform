/**
 * InviteLink.tsx
 *
 * A shareable link that opens the job form with this freelancer's address
 * already filled in (issue #80). Shown on a freelancer's profile, so a client
 * who has found the right person never has to retype a 56-character address.
 *
 * Contributor Notes:
 * - The link is stateless (see `lib/invite.ts`): no token, no server call. The
 *   address is re-validated when the form reads it, because a URL is editable.
 * - The full URL is printed as well as copied. Clipboard permission can be
 *   denied (or unavailable on a plain-http origin), and a link the user can
 *   select by hand is the fallback.
 * - Copy feedback is a live region (`role="status"`), matching AddressField.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isValidStellarAddress } from "../lib/address";
import { copyText } from "../lib/clipboard";
import { buildInviteLink, invitePath } from "../lib/invite";

/** How long the "copied" confirmation stays on screen. */
const COPIED_MS = 2_000;

export default function InviteLink({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number>();

  // A copy that resolves after navigation must not set state on an unmounted
  // component.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // A malformed route param is already reported by the reputation read; there is
  // no useful invite link to offer for a value that is not an account id.
  if (!isValidStellarAddress(address)) return null;

  const link = buildInviteLink(address);

  async function handleCopy() {
    const ok = await copyText(link);
    setCopied(ok);
    setFailed(!ok);
    window.clearTimeout(timer.current);
    if (ok) timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }

  return (
    <section aria-labelledby="invite-link-heading">
      <h2 id="invite-link-heading">Invite to a job</h2>
      <p className="muted">
        Open this link to post a job for this freelancer with their address
        already filled in, or copy it and send it to whoever is posting the job.
      </p>
      <p>
        <Link to={invitePath(address)}>Open the job form</Link>{" "}
        <button type="button" onClick={() => void handleCopy()}>
          Copy invite link
        </button>
      </p>
      <p className="muted">
        <code style={{ wordBreak: "break-all" }}>{link}</code>
      </p>
      {copied && (
        <p role="status" className="muted">
          Invite link copied.
        </p>
      )}
      {failed && (
        <p role="alert" className="muted">
          Could not copy — select the link above instead.
        </p>
      )}
    </section>
  );
}
