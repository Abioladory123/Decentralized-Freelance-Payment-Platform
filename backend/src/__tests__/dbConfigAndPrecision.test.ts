import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatDatabaseUrl, withTransactionRetry } from "../db";
import { formatAmount, sumAmounts, toBaseUnits } from "../lib/assets";

describe("Database Configuration, Precision, and Concurrency (Issues #273, #274, #275, #276)", () => {
  const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");
  const migrationDir = path.resolve(__dirname, "../../prisma/migrations");

  describe("Prisma Connection Pool & Timeout Parameters (Issue #275)", () => {
    it("formatDatabaseUrl injects statement_timeout, connection_limit, and pool_timeout defaults", () => {
      const rawUrl = "postgresql://postgres:postgres@localhost:5432/freelance_stellar";
      const formatted = formatDatabaseUrl(rawUrl)!;
      const url = new URL(formatted);

      expect(url.searchParams.get("statement_timeout")).toBe("10000");
      expect(url.searchParams.get("connection_limit")).toBe("10");
      expect(url.searchParams.get("pool_timeout")).toBe("10");
    });

    it("formatDatabaseUrl respects explicit options and environment overrides", () => {
      const rawUrl = "postgresql://postgres:postgres@localhost:5432/freelance_stellar";
      const formatted = formatDatabaseUrl(rawUrl, {
        connectionLimit: 25,
        statementTimeoutMs: 15000,
        poolTimeoutSeconds: 15,
      })!;
      const url = new URL(formatted);

      expect(url.searchParams.get("connection_limit")).toBe("25");
      expect(url.searchParams.get("statement_timeout")).toBe("15000");
      expect(url.searchParams.get("pool_timeout")).toBe("15");
    });

    it("formatDatabaseUrl preserves existing query parameters in database URL", () => {
      const rawUrl =
        "postgresql://postgres:postgres@localhost:5432/freelance_stellar?schema=public&sslmode=disable&connection_limit=30";
      const formatted = formatDatabaseUrl(rawUrl)!;
      const url = new URL(formatted);

      expect(url.searchParams.get("schema")).toBe("public");
      expect(url.searchParams.get("sslmode")).toBe("disable");
      expect(url.searchParams.get("connection_limit")).toBe("30");
      expect(url.searchParams.get("statement_timeout")).toBe("10000");
    });
  });

  describe("Serialization Conflict Retries & RepeatableRead Support (Issue #276)", () => {
    it("withTransactionRetry returns result on immediate success", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await withTransactionRetry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("withTransactionRetry retries on P2034 write conflict and recovers", async () => {
      const conflictError = Object.assign(new Error("Write conflict"), { code: "P2034" });
      const fn = vi
        .fn()
        .mockRejectedValueOnce(conflictError)
        .mockResolvedValueOnce("recovered");

      const result = await withTransactionRetry(fn);
      expect(result).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("withTransactionRetry retries on PostgreSQL serialization failure error message", async () => {
      const serializationErr = new Error(
        "could not serialize access due to concurrent update",
      );
      const fn = vi
        .fn()
        .mockRejectedValueOnce(serializationErr)
        .mockResolvedValueOnce("success_after_serialization");

      const result = await withTransactionRetry(fn);
      expect(result).toBe("success_after_serialization");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("withTransactionRetry does not retry on normal non-transient errors", async () => {
      const normalError = new Error("Unique constraint violation");
      const fn = vi.fn().mockRejectedValue(normalError);

      await expect(withTransactionRetry(fn)).rejects.toThrow("Unique constraint violation");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("Strict Decimal Precision (36, 18) for Financial Amounts (Issue #273)", () => {
    it("schema.prisma defines @db.Decimal(36, 18) for all financial amount columns", () => {
      expect(existsSync(schemaPath)).toBe(true);
      const schema = readFileSync(schemaPath, "utf8");

      expect(schema).toMatch(/totalAmount\s+Decimal\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/amount\s+Decimal\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/releasedAmount\s+Decimal\s+@default\(0\)\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/clientShare\s+Decimal\?\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/freelancerShare\s+Decimal\?\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/amount\s+Decimal\?\s+@db\.Decimal\(36,\s*18\)/);
      expect(schema).toMatch(/proposedRate\s+Decimal\?\s+@db\.Decimal\(36,\s*18\)/);
    });

    it("handles 18-decimal token amounts without rounding loss or truncation", () => {
      const microUnit = "0.000000000000000001"; // 18 decimal places
      const base = toBaseUnits(microUnit, 18);
      expect(base).toBe(1n);

      const formatted = formatAmount(base, 18);
      expect(formatted).toBe(microUnit);

      const sum = sumAmounts([microUnit, "0.000000000000000002", "100.5"], 18);
      expect(formatAmount(sum, 18)).toBe("100.500000000000000003");
    });

    it("migration exists with ALTER TABLE statements enforcing DECIMAL(36, 18)", () => {
      const migrationFile = path.join(
        migrationDir,
        "20261118183000_decimal_precision_and_chain_event_action_index",
        "migration.sql",
      );
      expect(existsSync(migrationFile)).toBe(true);
      const sql = readFileSync(migrationFile, "utf8");
      expect(sql).toContain('ALTER TABLE "Job" ALTER COLUMN "totalAmount" TYPE DECIMAL(36, 18)');
      expect(sql).toContain('ALTER TABLE "Milestone" ALTER COLUMN "amount" TYPE DECIMAL(36, 18)');
      expect(sql).toContain('ALTER COLUMN "releasedAmount" SET DATA TYPE DECIMAL(36, 18)');
    });
  });

  describe("Database Index on ChainEvent [action, ledger] (Issue #274)", () => {
    it("schema.prisma declares @@index([action, ledger]) on ChainEvent", () => {
      const schema = readFileSync(schemaPath, "utf8");
      expect(schema).toContain("@@index([action, ledger])");
    });

    it("migration script creates ChainEvent_action_ledger_idx", () => {
      const migrationFile = path.join(
        migrationDir,
        "20261118183000_decimal_precision_and_chain_event_action_index",
        "migration.sql",
      );
      const sql = readFileSync(migrationFile, "utf8");
      expect(sql).toContain(
        'CREATE INDEX "ChainEvent_action_ledger_idx" ON "ChainEvent"("action", "ledger")',
      );
    });
  });
});
