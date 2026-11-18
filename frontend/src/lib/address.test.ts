import { describe, expect, it } from "vitest";
import { isValidStellarAddress, shortAddress } from "./address";

// A real 56-character account id (the deploy admin in deployments/testnet.json).
const ACCOUNT = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

describe("shortAddress", () => {
  it("keeps the first six and the last four characters", () => {
    expect(shortAddress(ACCOUNT)).toBe("GBPLJH…Q75B");
  });

  it("leaves a value too short to abbreviate unmodified", () => {
    // Abbreviating these would make both ends overlap and print a fragment that
    // looks like a different address.
    expect(shortAddress("GABCD")).toBe("GABCD");
    expect(shortAddress("GABCDEFGHI")).toBe("GABCDEFGHI");
    expect(shortAddress("GABCDEFGHIJ")).toBe("GABCDE…GHIJ");
  });
});

describe("isValidStellarAddress", () => {
  it("accepts a real account id", () => {
    expect(isValidStellarAddress(ACCOUNT)).toBe(true);
  });

  it("rejects values of the wrong shape", () => {
    expect(isValidStellarAddress("")).toBe(false);
    expect(isValidStellarAddress("GABCD")).toBe(false);
    expect(isValidStellarAddress(`S${ACCOUNT.slice(1)}`)).toBe(false);
    expect(isValidStellarAddress(`${ACCOUNT}A`)).toBe(false);
  });

  it("rejects a correctly shaped id whose checksum does not verify", () => {
    expect(isValidStellarAddress(`G${"A".repeat(55)}`)).toBe(false);
  });
});
