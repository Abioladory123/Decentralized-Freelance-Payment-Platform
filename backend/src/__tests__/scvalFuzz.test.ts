import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  buildArbitrateArgs,
  buildFundArgs,
  buildRaiseArgs,
  buildReputationSubmitArgs,
  scAddress,
  scI128,
  scString,
  scU32,
  scU64,
} from "../lib/scval";
import { buildCreateArgs } from "../lib/escrowArgs";

const tag = (val: xdr.ScVal): string => val.switch().name;

const MAX_U32 = 4294967295;
const MAX_U64 = 18446744073709551615n;
const MIN_I128 = -(2n ** 127n);
const MAX_I128 = 2n ** 127n - 1n;

const u64Arbitrary = fc.bigInt({ min: 0n, max: MAX_U64 });
const i128Arbitrary = fc.bigInt({ min: MIN_I128, max: MAX_I128 });

describe("Property-based fuzz testing for ScVal argument encoding/decoding (Issue #281)", () => {
  describe("Primitive encoders", () => {
    it("scU32 encodes arbitrary valid u32 values and roundtrips without throwing", () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: MAX_U32 }), (n) => {
          const val = scU32(n);
          expect(tag(val)).toBe("scvU32");
          expect(val.u32()).toBe(n);
          expect(scValToNative(val)).toBe(n);
          expect(val.toXDR().length).toBeGreaterThan(0);
        }),
        { numRuns: 1000 },
      );
    });

    it("scU64 encodes arbitrary valid non-negative bigints up to 2^64-1", () => {
      fc.assert(
        fc.property(u64Arbitrary, (n) => {
          const val = scU64(n);
          expect(tag(val)).toBe("scvU64");
          expect(scValToNative(val)).toBe(n);
          expect(val.toXDR().length).toBeGreaterThan(0);
        }),
        { numRuns: 1000 },
      );
    });

    it("scI128 encodes arbitrary signed 128-bit bigints", () => {
      fc.assert(
        fc.property(i128Arbitrary, (n) => {
          const val = scI128(n);
          expect(tag(val)).toBe("scvI128");
          expect(scValToNative(val)).toBe(n);
          expect(val.toXDR().length).toBeGreaterThan(0);
        }),
        { numRuns: 1000 },
      );
    });

    it("scString safely encodes arbitrary unicode, emojis, control chars, and empty strings", () => {
      fc.assert(
        fc.property(fc.string(), (str) => {
          const val = scString(str);
          expect(tag(val)).toBe("scvString");
          expect(scValToNative(val)).toBe(str);
          expect(val.toXDR().length).toBeGreaterThan(0);
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe("buildFundArgs fuzzing", () => {
    it("handles 1000+ random valid and edge-case escrow IDs without uncaught exceptions", () => {
      fc.assert(
        fc.property(u64Arbitrary, (escrowId) => {
          const args = buildFundArgs(escrowId);
          expect(args).toHaveLength(1);
          expect(tag(args[0])).toBe("scvU64");
          expect(scValToNative(args[0])).toBe(escrowId);
          expect(args[0].toXDR("base64")).toBeDefined();
        }),
        { numRuns: 1000 },
      );
    });

    it("predictably rejects negative or out-of-range numeric inputs", () => {
      fc.assert(
        fc.property(fc.bigInt({ max: -1n }), (negativeId) => {
          expect(() => buildFundArgs(negativeId)).toThrow();
        }),
        { numRuns: 200 },
      );
    });
  });

  describe("buildArbitrateArgs fuzzing", () => {
    it("encodes valid dispute IDs and arbitrary i128 shares safely", () => {
      fc.assert(
        fc.property(
          u64Arbitrary,
          i128Arbitrary,
          i128Arbitrary,
          (disputeId, clientShare, freelancerShare) => {
            const args = buildArbitrateArgs(disputeId, clientShare, freelancerShare);
            expect(args.map(tag)).toEqual(["scvU64", "scvI128", "scvI128"]);
            expect(scValToNative(args[0])).toBe(disputeId);
            expect(scValToNative(args[1])).toBe(clientShare);
            expect(scValToNative(args[2])).toBe(freelancerShare);
            for (const arg of args) {
              expect(arg.toXDR().length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  describe("buildCreateArgs & milestone encoding fuzzing", () => {
    const validAddressArbitrary = fc.constantFrom(
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
    );

    const milestoneArbitrary = fc.record({
      amount: fc.bigInt({ min: 0n, max: MAX_I128 }),
      deadline: u64Arbitrary,
      released: fc.option(fc.boolean(), { nil: undefined }),
      releasedAmount: fc.option(fc.bigInt({ min: 0n, max: MAX_I128 }), { nil: undefined }),
    });

    it("encodes valid escrow creation structures across 1000+ iterations", () => {
      fc.assert(
        fc.property(
          validAddressArbitrary,
          validAddressArbitrary,
          validAddressArbitrary,
          fc.array(milestoneArbitrary, { minLength: 1, maxLength: 5 }),
          u64Arbitrary,
          (client, freelancer, token, milestones, expiry) => {
            const args = buildCreateArgs({
              client,
              freelancer,
              token,
              milestones,
              expiry,
            });

            expect(args).toHaveLength(5);
            expect(args.map(tag)).toEqual([
              "scvAddress",
              "scvAddress",
              "scvAddress",
              "scvVec",
              "scvU64",
            ]);

            // Ensure vec entries are valid ScMaps with ascending symbol keys
            const vec = args[3].vec() ?? [];
            expect(vec).toHaveLength(milestones.length);

            for (let i = 0; i < milestones.length; i++) {
              const mVal = vec[i];
              expect(tag(mVal)).toBe("scvMap");
              const map = mVal.map() ?? [];
              const keys = map.map((e) => e.key().sym().toString());
              expect(keys).toEqual(["amount", "deadline", "released", "released_amount"]);

              expect(scValToNative(map[0].val())).toBe(milestones[i].amount);
              expect(scValToNative(map[1].val())).toBe(milestones[i].deadline);
              expect(scValToNative(map[2].val())).toBe(milestones[i].released ?? false);
              expect(scValToNative(map[3].val())).toBe(milestones[i].releasedAmount ?? 0n);
            }

            expect(scValToNative(args[4])).toBe(expiry);
            for (const arg of args) {
              expect(arg.toXDR().length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("predictably rejects arbitrary invalid address strings without unhandled panics", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1, maxLength: 60 }), (invalidAddr) => {
          // If the randomly generated string happens to be a valid Stellar public key or contract address,
          // scAddress will succeed. Otherwise it must throw an Error predictably.
          try {
            const val = scAddress(invalidAddr);
            expect(tag(val)).toBe("scvAddress");
          } catch (err) {
            expect(err).toBeInstanceOf(Error);
          }
        }),
        { numRuns: 1000 },
      );
    });
  });

  describe("buildRaiseArgs & buildReputationSubmitArgs fuzzing", () => {
    const validAddressArbitrary = fc.constantFrom(
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
    );

    it("buildRaiseArgs safely encodes arbitrary dispute reasons (including multiline, unicode, edge strings)", () => {
      fc.assert(
        fc.property(
          u64Arbitrary,
          validAddressArbitrary,
          validAddressArbitrary,
          fc.string(),
          (escrowId, escrowContract, raisedBy, reason) => {
            const args = buildRaiseArgs(escrowId, escrowContract, raisedBy, reason);
            expect(args.map(tag)).toEqual([
              "scvU64",
              "scvAddress",
              "scvAddress",
              "scvString",
            ]);
            expect(scValToNative(args[0])).toBe(escrowId);
            expect(scValToNative(args[3])).toBe(reason);
            for (const arg of args) {
              expect(arg.toXDR().length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("buildReputationSubmitArgs safely encodes scores and parties across 1000 runs", () => {
      fc.assert(
        fc.property(
          validAddressArbitrary,
          validAddressArbitrary,
          u64Arbitrary,
          fc.integer({ min: 1, max: 5 }),
          (rater, ratee, escrowId, score) => {
            const args = buildReputationSubmitArgs(rater, ratee, escrowId, score);
            expect(args.map(tag)).toEqual([
              "scvAddress",
              "scvAddress",
              "scvU64",
              "scvU32",
            ]);
            expect(scValToNative(args[2])).toBe(escrowId);
            expect(scValToNative(args[3])).toBe(score);
            for (const arg of args) {
              expect(arg.toXDR().length).toBeGreaterThan(0);
            }
          },
        ),
        { numRuns: 1000 },
      );
    });
  });
});
