/**
 * scripts/archive_historical_jobs.ts
 *
 * Maintenance CLI script for archiving completed and refunded jobs older than a
 * retention period (defaults to 365 days / 1 year) into cold archive storage
 * (ArchivedJob model and optional JSON disk dump), pruning them from operational
 * tables to minimize index bloat and keep active query scans fast (issue #272).
 *
 * Usage:
 *   npx tsx scripts/archive_historical_jobs.ts [options]
 *
 * Options:
 *   --retention-days <number>   Retention threshold in days (default: 365)
 *   --batch-size <number>       Number of jobs processed per batch (default: 50)
 *   --dry-run                   Scan and report eligible jobs without modifying DB
 *   --export-dir <dir>          Optional filesystem directory to write JSON records
 */

import "dotenv/config";
import { createPrismaClient } from "../backend/src/db";
import { archiveHistoricalJobs, type ArchiveOptions, type ArchiveResult } from "../backend/src/lib/archiver";

export { archiveHistoricalJobs, type ArchiveOptions, type ArchiveResult };

// CLI runner
if (require.main === module || (typeof process !== "undefined" && process.argv[1]?.endsWith("archive_historical_jobs.ts"))) {
  const args = process.argv.slice(2);
  const options: ArchiveOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--retention-days" && args[i + 1]) {
      options.retentionDays = parseInt(args[++i], 10);
    } else if (args[i] === "--batch-size" && args[i + 1]) {
      options.batchSize = parseInt(args[++i], 10);
    } else if (args[i] === "--dry-run") {
      options.dryRun = true;
    } else if (args[i] === "--export-dir" && args[i + 1]) {
      options.exportDir = args[++i];
    }
  }

  const prisma = createPrismaClient();

  archiveHistoricalJobs(options, prisma)
    .then((result) => {
      console.log("=== Historical Job Archival Run Summary ===");
      console.log(`Cutoff Date:    ${result.cutoffDate.toISOString()}`);
      console.log(`Dry Run:        ${result.dryRun}`);
      console.log(`Jobs Eligible:  ${result.eligibleCount}`);
      console.log(`Jobs Archived:  ${result.archivedCount}`);
      console.log(`Errors:         ${result.errorCount}`);
      if (result.errors.length > 0) {
        console.error("Encountered errors:", result.errors);
      }
    })
    .catch((err) => {
      console.error("Fatal error running archival script:", err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
