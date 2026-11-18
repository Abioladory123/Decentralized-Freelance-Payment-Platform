import { Router, type RequestHandler } from "express";
import { prisma } from "../db";
import { config } from "../config";
import { isListed, parseList } from "../lib/access";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { dispatchEvent, restoreDeadLetterEvent } from "../indexer";

export const adminIndexerRouter = Router();

const requireIndexerAdmin: RequestHandler = (_req, res, next) => {
  const admins = parseList(config.INDEXER_ADMIN_ADDRESSES);
  if (admins.length === 0) {
    return next(new AppError(503, "Indexer administration is unavailable: no admins configured"));
  }
  if (!isListed(res.locals.stellarAddress, admins)) {
    return next(new AppError(403, "Only a configured admin can access indexer administration"));
  }
  next();
};

// GET /api/admin/indexer/dead-letters (issue #246)
adminIndexerRouter.get("/dead-letters", requireAuth, requireIndexerAdmin, async (req, res, next) => {
  try {
    let limit = 50;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(String(req.query.limit), 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        throw new AppError(400, "Invalid limit parameter");
      }
      limit = Math.min(parsedLimit, 100);
    }

    let offset = 0;
    if (req.query.offset !== undefined) {
      const parsedOffset = parseInt(String(req.query.offset), 10);
      if (isNaN(parsedOffset) || parsedOffset < 0) {
        throw new AppError(400, "Invalid offset parameter");
      }
      offset = parsedOffset;
    }

    const [deadLetters, total] = await Promise.all([
      prisma.indexerDeadLetter.findMany({
        select: {
          id: true,
          ledger: true,
          eventName: true,
          contractId: true,
          error: true,
          attempts: true,
          firstSeenAt: true,
          lastSeenAt: true,
        },
        orderBy: { lastSeenAt: "desc" },
        skip: offset,
        take: limit,
      }),
      prisma.indexerDeadLetter.count(),
    ]);

    res.json({ deadLetters, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

async function replay(id: string): Promise<void> {
  const row = await prisma.indexerDeadLetter.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Dead-letter event not found");

  let event;
  try {
    event = restoreDeadLetterEvent(row.eventPayload);
  } catch {
    throw new AppError(409, "Dead-letter event has no valid replay payload");
  }

  await dispatchEvent(event);
  await prisma.indexerDeadLetter.delete({ where: { id } });
}

adminIndexerRouter.post("/replay/:id", requireAuth, requireIndexerAdmin, async (req, res, next) => {
  try {
    await replay(req.params.id);
    res.json({ replayed: 1, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

adminIndexerRouter.post("/replay-all", requireAuth, requireIndexerAdmin, async (_req, res, next) => {
  try {
    const rows = await prisma.indexerDeadLetter.findMany({ orderBy: { lastSeenAt: "asc" } });
    const replayed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const row of rows) {
      try {
        await replay(row.id);
        replayed.push(row.id);
      } catch (err) {
        failed.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({ replayed: replayed.length, failed });
  } catch (err) {
    next(err);
  }
});
