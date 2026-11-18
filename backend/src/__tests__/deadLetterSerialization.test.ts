import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import {
  serializeDeadLetterEvent,
  restoreDeadLetterEvent,
  type ContractEventLike,
} from "../indexer";

describe("Dead Letter Event Serialization & Deserialization", () => {
  it("successfully serializes and restores a complete ContractEventLike with all metadata", () => {
    const originalEvent: ContractEventLike = {
      ledger: 123456,
      id: "event-id-001",
      txHash: "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
      ledgerClosedAt: "2026-11-18T12:00:00Z",
      topic: [
        xdr.ScVal.scvSymbol("dispute_opened"),
        xdr.ScVal.scvU64(new xdr.Uint64(42n)),
      ],
      value: xdr.ScVal.scvString("Dispute reason: milestone delayed"),
    };

    const serialized = serializeDeadLetterEvent(originalEvent);

    expect(serialized).toEqual({
      ledger: 123456,
      id: "event-id-001",
      txHash: "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0",
      ledgerClosedAt: "2026-11-18T12:00:00Z",
      topic: [
        originalEvent.topic[0].toXDR("base64"),
        originalEvent.topic[1].toXDR("base64"),
      ],
      value: originalEvent.value.toXDR("base64"),
    });

    const restored = restoreDeadLetterEvent(serialized);

    expect(restored.ledger).toBe(originalEvent.ledger);
    expect(restored.id).toBe(originalEvent.id);
    expect(restored.txHash).toBe(originalEvent.txHash);
    expect(restored.ledgerClosedAt).toBe(originalEvent.ledgerClosedAt);
    expect(restored.topic).toHaveLength(2);
    expect(restored.topic[0].toXDR("base64")).toBe(originalEvent.topic[0].toXDR("base64"));
    expect(restored.topic[1].toXDR("base64")).toBe(originalEvent.topic[1].toXDR("base64"));
    expect(restored.value.toXDR("base64")).toBe(originalEvent.value.toXDR("base64"));
  });

  it("successfully serializes and restores a minimal ContractEventLike without optional fields", () => {
    const minimalEvent: ContractEventLike = {
      ledger: 9999,
      topic: [xdr.ScVal.scvSymbol("created")],
      value: xdr.ScVal.scvU32(100),
    };

    const serialized = serializeDeadLetterEvent(minimalEvent);

    expect(serialized).toEqual({
      ledger: 9999,
      topic: [minimalEvent.topic[0].toXDR("base64")],
      value: minimalEvent.value.toXDR("base64"),
    });
    expect(serialized).not.toHaveProperty("id");
    expect(serialized).not.toHaveProperty("txHash");
    expect(serialized).not.toHaveProperty("ledgerClosedAt");

    const restored = restoreDeadLetterEvent(serialized);

    expect(restored.ledger).toBe(9999);
    expect(restored.id).toBeUndefined();
    expect(restored.txHash).toBeUndefined();
    expect(restored.ledgerClosedAt).toBeUndefined();
    expect(restored.topic).toHaveLength(1);
    expect(restored.topic[0].toXDR("base64")).toBe(minimalEvent.topic[0].toXDR("base64"));
    expect(restored.value.toXDR("base64")).toBe(minimalEvent.value.toXDR("base64"));
  });

  describe("Payload validation and error handling", () => {
    it("rejects non-object and null payloads with descriptive error", () => {
      expect(() => restoreDeadLetterEvent(null)).toThrow(
        "Dead letter has no replayable event payload"
      );
      expect(() => restoreDeadLetterEvent(undefined)).toThrow(
        "Dead letter has no replayable event payload"
      );
      expect(() => restoreDeadLetterEvent("invalid-string")).toThrow(
        "Dead letter has no replayable event payload"
      );
      expect(() => restoreDeadLetterEvent(12345)).toThrow(
        "Dead letter has no replayable event payload"
      );
      expect(() => restoreDeadLetterEvent([1, 2, 3])).toThrow(
        "Dead letter has no replayable event payload"
      );
    });

    it("rejects invalid or non-integer ledger numbers", () => {
      const validTopic = [xdr.ScVal.scvSymbol("test").toXDR("base64")];
      const validValue = xdr.ScVal.scvVoid().toXDR("base64");

      expect(() =>
        restoreDeadLetterEvent({ ledger: "100", topic: validTopic, value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100.5, topic: validTopic, value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: null, topic: validTopic, value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ topic: validTopic, value: validValue })
      ).toThrow("Dead letter event payload is invalid");
    });

    it("rejects missing, non-array, or invalid topic elements", () => {
      const validValue = xdr.ScVal.scvVoid().toXDR("base64");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: "not-an-array", value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: null, value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: [123, 456], value: validValue })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: ["valid", null], value: validValue })
      ).toThrow("Dead letter event payload is invalid");
    });

    it("rejects missing or non-string value", () => {
      const validTopic = [xdr.ScVal.scvSymbol("test").toXDR("base64")];

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: validTopic })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: validTopic, value: 42 })
      ).toThrow("Dead letter event payload is invalid");

      expect(() =>
        restoreDeadLetterEvent({ ledger: 100, topic: validTopic, value: { foo: "bar" } })
      ).toThrow("Dead letter event payload is invalid");
    });

    it("gracefully catches and rejects corrupted XDR base64 in topic or value", () => {
      const validTopic = [xdr.ScVal.scvSymbol("test").toXDR("base64")];
      const validValue = xdr.ScVal.scvVoid().toXDR("base64");

      // Corrupted topic
      expect(() =>
        restoreDeadLetterEvent({
          ledger: 100,
          topic: ["%%%not-valid-base64%%%"],
          value: validValue,
        })
      ).toThrow(/Failed to decode XDR from dead letter event payload/);

      // Corrupted value
      expect(() =>
        restoreDeadLetterEvent({
          ledger: 100,
          topic: validTopic,
          value: "not_valid_xdr_payload!!!",
        })
      ).toThrow(/Failed to decode XDR from dead letter event payload/);
    });
  });
});
