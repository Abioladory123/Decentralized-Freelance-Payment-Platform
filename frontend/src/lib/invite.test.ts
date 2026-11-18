import { describe, expect, it } from "vitest";
import { buildInviteLink, freelancerFromInvite, invitePath } from "./invite";

// A real 56-character account id (the deploy admin in deployments/testnet.json).
const FREELANCER = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

describe("invitePath", () => {
  it("opens the job form with the freelancer address pre-filled", () => {
    expect(invitePath(FREELANCER)).toBe(`/post?freelancer=${FREELANCER}`);
  });

  it("trims surrounding whitespace from a pasted address", () => {
    expect(invitePath(`  ${FREELANCER}  `)).toBe(`/post?freelancer=${FREELANCER}`);
  });

  it("refuses to build a link for a malformed address", () => {
    // A checksum-invalid value looks like an address but is not one; a link for
    // it would be silently ignored when opened.
    expect(() => invitePath("GABCD")).toThrow(/Invalid Stellar address/);
    expect(() => invitePath(`G${"A".repeat(55)}`)).toThrow(/Invalid Stellar address/);
    expect(() => invitePath("")).toThrow(/Invalid Stellar address/);
  });
});

describe("buildInviteLink", () => {
  it("produces an absolute, shareable link for the given origin", () => {
    expect(buildInviteLink(FREELANCER, "https://app.example")).toBe(
      `https://app.example/post?freelancer=${FREELANCER}`,
    );
  });
});

describe("freelancerFromInvite", () => {
  it("reads a valid address from the query string", () => {
    expect(freelancerFromInvite(`?freelancer=${FREELANCER}`)).toBe(FREELANCER);
    expect(freelancerFromInvite(`?status=CREATED&freelancer=${FREELANCER}`)).toBe(
      FREELANCER,
    );
  });

  it("returns null when the parameter is absent", () => {
    expect(freelancerFromInvite("")).toBeNull();
    expect(freelancerFromInvite("?status=CREATED")).toBeNull();
  });

  it("returns null for an editable, invalid value instead of trusting it", () => {
    expect(freelancerFromInvite("?freelancer=not-an-address")).toBeNull();
    expect(freelancerFromInvite("?freelancer=GABCD")).toBeNull();
    // Shape-valid but checksum-invalid.
    expect(freelancerFromInvite(`?freelancer=G${"A".repeat(55)}`)).toBeNull();
  });
});
