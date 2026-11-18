/**
 * metrics.ts route
 *
 * Prometheus scrape endpoint GET /metrics (issue #305).
 */

import { Router } from "express";
import { register, collectDynamicMetrics } from "../lib/metrics";
import { metricsAuth } from "../middleware/metricsAuth";

export const metricsRouter = Router();

metricsRouter.get("/", metricsAuth(), async (_req, res, next) => {
  try {
    await collectDynamicMetrics();
    res.setHeader("Content-Type", register.contentType);
    const output = await register.metrics();
    res.send(output);
  } catch (err) {
    next(err);
  }
});
