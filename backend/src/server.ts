import "dotenv/config";
import { createApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";
import { startIndexer } from "./indexer";
import { createShutdownHandler } from "./lib/shutdown";
import { verifyContractConfigurationSync } from "./lib/contractFreshness";

async function main() {
  await prisma.$connect();

  // Automated contract configuration drift check (issue #316)
  if (config.ESCROW_CONTRACT_ID || config.DISPUTE_CONTRACT_ID) {
    try {
      await verifyContractConfigurationSync({
        escrowContractId: config.ESCROW_CONTRACT_ID,
        disputeContractId: config.DISPUTE_CONTRACT_ID,
        arbitratorAddresses: config.ARBITRATOR_ADDRESSES,
      });
    } catch (err) {
      console.warn("[config] Contract configuration verification warning:", err);
    }
  }

  const app = createApp();
  // Keep the `listen` handle: closing it is what lets in-flight requests finish
  // instead of being cut off mid-response (issue #26).
  const server = app.listen(config.PORT, () => {
    console.log(`Backend running on port ${config.PORT} [${config.NODE_ENV}]`);
  });

  // The handle is what a SIGTERM uses to clear the polling interval.
  const indexer = startIndexer();

  const shutdown = createShutdownHandler({
    stopIndexer: () => indexer.stop(),
    closeServer: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    disconnect: () => prisma.$disconnect(),
    exit: (code) => process.exit(code),
  });

  // Render (and `docker stop`) send SIGTERM; Ctrl+C sends SIGINT. Both drain.
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
