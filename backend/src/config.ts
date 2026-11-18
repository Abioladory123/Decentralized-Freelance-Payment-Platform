import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(32),
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HORIZON_URL: z.string().url().optional(),
  SOROBAN_RPC_URL: z.string().url(),
  ESCROW_CONTRACT_ID: z.string().default(""),
  DISPUTE_CONTRACT_ID: z.string().default(""),
  REPUTATION_CONTRACT_ID: z.string().default(""),
  USDC_CONTRACT_ID: z.string().default(""),
  XLM_CONTRACT_ID: z.string().default(""),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  // Dedicated budget for the wallet-auth endpoints (issue #44), applied per IP
  // and per route on top of the global 100/min limiter in app.ts. Nonce
  // issuance and signature attempts are the cheapest thing to script, so they
  // get a much tighter cap than the rest of the API.
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // How far ahead a milestone deadline counts as "due soon" for the in-app
  // reminders (issue #74). A per-request `?withinHours=` overrides it.
  REMINDER_HORIZON_HOURS: z.coerce.number().default(48),
  // Comma-separated Stellar addresses that may resolve disputes through the
  // API. Empty means "nobody", not "everybody": the route fails closed.
  ARBITRATOR_ADDRESSES: z.string().default(""),
  // Comma-separated wallet addresses authorized to operate admin endpoints.
  // Empty means "nobody", not "everybody".
  INDEXER_ADMIN_ADDRESSES: z.string().default(""),
  // Comma-separated browser origins allowed to call the API (e.g. the Vercel
  // frontend). Empty means "no restriction" in development, but production
  // warns loudly because that allows every origin.
  CORS_ORIGIN: z.string().default(""),
  // Reverse proxy hop count (e.g. 1 behind Render, Heroku, or Nginx).
  // Configures Express 'trust proxy' so rate limiting keys on the real client IP.
  // 0 disables proxy trust (default).
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Alert webhook URL (Slack, Discord, PagerDuty, or custom webhook) for indexer lag and dead-letter growth (issue #306).
  ALERT_WEBHOOK_URL: z.string().default(""),
  // Maximum allowed difference between chain tip ledger and indexer cursor before alerting.
  INDEXER_LAG_ALERT_THRESHOLD: z.coerce.number().int().positive().default(1000),
  // Maximum unhandled dead-letter rows before alerting.
  DEAD_LETTER_ALERT_THRESHOLD: z.coerce.number().int().positive().default(10),
  // Prisma connection pool settings (issue #275).
  // DATABASE_POOL_SIZE controls connection_limit (default: 10 in containerized/production setups).
  // DATABASE_TIMEOUT_MS controls query statement_timeout in ms and pool_timeout (default: 10_000).
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DATABASE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Prometheus metrics auth (issue #305).
  METRICS_USER: z.string().default(""),
  METRICS_PASSWORD: z.string().default(""),
  METRICS_TOKEN: z.string().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
