/**
 * metricsAuth.ts
 *
 * Protects the Prometheus /metrics endpoint via HTTP Basic Auth or Bearer Token (issue #305).
 * Configured via METRICS_USER, METRICS_PASSWORD, or METRICS_TOKEN.
 */

import type { RequestHandler } from "express";
import { config } from "../config";

export function metricsAuth(): RequestHandler {
  return (req, res, next) => {
    const user = config.METRICS_USER;
    const password = config.METRICS_PASSWORD;
    const token = config.METRICS_TOKEN;

    // When no auth credentials are configured, allow access
    if (!user && !password && !token) {
      return next();
    }

    const authHeader = req.headers.authorization;

    // Check token if configured
    if (token) {
      if (authHeader === `Bearer ${token}` || req.query.token === token) {
        return next();
      }
    }

    // Check basic auth if configured
    if (user && password) {
      if (authHeader && authHeader.startsWith("Basic ")) {
        try {
          const credentials = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
          const colonIndex = credentials.indexOf(":");
          if (colonIndex !== -1) {
            const u = credentials.slice(0, colonIndex);
            const p = credentials.slice(colonIndex + 1);
            if (u === user && p === password) {
              return next();
            }
          }
        } catch {
          // Bad base64
        }
      }
    }

    res.setHeader("WWW-Authenticate", 'Basic realm="Prometheus Metrics"');
    return res.status(401).send("Unauthorized: Invalid metrics credentials\n");
  };
}
