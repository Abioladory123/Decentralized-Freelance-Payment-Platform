/**
 * disputes.ts
 *
 * Raising a dispute is two transactions on two contracts, and the order matters:
 *
 *   1. `escrow.open_dispute(escrow_id, initiator)`   — freezes the escrow.
 *   2. `dispute.raise(escrow_id, escrow_contract, raised_by, reason)` — tells the
 *      dispute contract about it and returns the dispute id the panel rules on.
 *
 * `escrow.open_dispute` alone leaves the escrow frozen with no dispute id, so
 * nothing can arbitrate it. The off-chain row is written before either runs
 * (there is no on-chain place to keep a `reason`), and the on-chain id is
 * attached to it afterwards — by the client through `/:id/sync`, or by the
 * indexer when it sees the `raised` event. Both write to the same row, keyed on
 * the job (see the `Dispute` model).
 *
 * Routes:
 *   POST /api/disputes              — record the dispute (intent), build open_dispute
 *   GET  /api/disputes/:id          — dispute detail
 *   GET  /api/disputes/:id/evidence — notes/attachments (parties + panel, #78)
 *   POST /api/disputes/:id/evidence — add evidence before arbitration (#78)
 *   POST /api/disputes/:id/raise    — build dispute.raise (either party)
 *   POST /api/disputes/:id/sync     — record the on-chain dispute id
 *   POST /api/disputes/:id/approve  — panel member votes a split (builds approve tx)
 *   POST /api/disputes/:id/resolve  — arbitrator resolves (builds arbitrate tx)
 *
 * Authorization: `/:id/resolve` may only be called by a member of the arbitrator
 * panel. The panel is read from the on-chain dispute contract (see
 * `lib/arbitratorPanel.ts`), so a `set_panel` rotation takes effect without a
 * redeploy; `ARBITRATOR_ADDRESSES` is only the fallback when the chain cannot
 * be read. The on-chain dispute contract is still the final
 * authority (it checks panel membership inside `arbitrate`), but the route also
 * writes DB state before the transaction is confirmed, so it must not be
 * reachable by a non-arbitrator.
 *
 * The escrow contract is the authority on every precondition the chain can
 * check — that the escrow is `Disputed`, that the raiser is a party, that the
 * panel approved the split — so those failures come back from simulation, which
 * `buildTx` translates with the right contract's error map. The off-chain checks
 * here are cheap early rejections, not the security boundary.
 */

import { Router } from "express";
import { z } from "zod";
import { Contract } from "@stellar/stellar-sdk";
import type { Dispute, Job, User } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { getAsset, toBaseUnits } from "../lib/assets";
import {
  buildApproveArgs,
  buildArbitrateArgs,
  buildOpenDisputeArgs,
  buildRaiseArgs,
} from "../lib/scval";
import {
  DISPUTE_ERROR_MESSAGES,
  ESCROW_ERROR_MESSAGES,
} from "../lib/contractErrors";
import { buildTx } from "../lib/soroban";
import { isListed } from "../lib/access";
import { getArbitratorPanel } from "../lib/arbitratorPanel";
import { requireAuth } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/errorHandler";
import { notifyDisputeOpened } from "../lib/notifications";

export const disputesRouter = Router();

/**
 * Resolve the job's asset, turning an unknown symbol into a 400.
 *
 * The escrow is asset-agnostic: `arbitrate` takes shares in the token's base
 * units, so the decimals have to come from the job's asset registry entry, not
 * from a constant (issue #35).
 */
function assetForJob(assetSymbol: string) {
  try {
    return getAsset(assetSymbol);
  } catch {
    throw new AppError(400, `Unknown asset: ${assetSymbol}`);
  }
}

/** A dispute row plus the parties a route has to authorize against. */
type DisputeWithParties = Dispute & { job: Job & { client: User; freelancer: User | null } };

/** Either party to the job may dispute it; nobody else may even build the tx. */
function assertParticipant(dispute: DisputeWithParties, address: string): void {
  const { client, freelancer } = dispute.job;
  if (client.stellarAddress !== address && freelancer?.stellarAddress !== address) {
    throw new AppError(403, "Not a participant of this job");
  }
}

/** Load a dispute with its parties, or fail with a 404. */
async function loadDispute(id: string): Promise<DisputeWithParties> {
  const dispute = await prisma.dispute.findUnique({
    where: { id },
    include: { job: { include: { client: true, freelancer: true } } },
  });
  if (!dispute) throw new AppError(404, "Dispute not found");
  return dispute;
}

/** True when `address` is on the current arbitration panel. Fails closed. */
async function isArbitrator(address: string): Promise<boolean> {
  const panel = await getArbitratorPanel();
  return panel.length > 0 && isListed(address, panel);
}

// ---------------------------------------------------------------------------
// Dispute evidence (issue #78)
// ---------------------------------------------------------------------------

/** Largest attachment accepted, matching the client's own check. */
export const MAX_EVIDENCE_FILE_BYTES = 2 * 1024 * 1024;

/** Base64 inflates by ~4/3, so a data URL may be that much larger plus its header. */
const MAX_EVIDENCE_DATA_URL_CHARS = Math.ceil((MAX_EVIDENCE_FILE_BYTES * 4) / 3) + 4096;

/** An attachment is an external http(s) link or an inline browser data URL. */
function isAllowedEvidenceUrl(value: string): boolean {
  if (value.startsWith("data:")) return value.length <= MAX_EVIDENCE_DATA_URL_CHARS;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * One evidence submission: a note, a file attachment, or both.
 *
 * The file follows the Deliverable shape (`fileName`/`fileUrl`/`fileSize`), so
 * the client can reuse its FileReader path; the size cap is enforced here as
 * well as in the browser, because the body is user-controlled.
 */
export const evidenceSchema = z
  .object({
    note: z.string().trim().min(1).max(2000).optional(),
    fileName: z.string().trim().min(1).max(255).optional(),
    fileUrl: z.string().trim().min(1).optional(),
    fileSize: z.number().int().positive().max(MAX_EVIDENCE_FILE_BYTES).optional(),
    fileType: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    const hasFile = Boolean(value.fileName && value.fileUrl);
    if (!value.note && !hasFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide a note or a file attachment",
      });
    }
    if (Boolean(value.fileName) !== Boolean(value.fileUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A file attachment needs both fileName and fileUrl",
      });
    }
    if (value.fileUrl && !isAllowedEvidenceUrl(value.fileUrl)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fileUrl must be an http(s) or data: URL",
      });
    }
  });

/** The author fields every evidence read exposes, without the user's email. */
const evidenceAuthor = { select: { stellarAddress: true, displayName: true } } as const;

// POST /api/disputes
//
// Records the dispute and returns the `escrow.open_dispute` transaction. The row
// is written first and without an on-chain id — it is the only place the reason
// is kept (`Raised` carries no reason), and it is what `handleRaised` and
// `/:id/sync` attach the on-chain id to later.
//
// The row starts PENDING and is deliberately invisible to `GET /:id` and to the
// `disputes[]` on a job until the id exists (#32): building a transaction is not
// disputing, and a user who never signs must not leave a phantom dispute.
//
// Idempotent per job: both parties can reach this route and only one row may
// exist (the contract refuses a second `raise` for the same escrow), so the
// first caller's reason wins and the second call is a no-op that returns the
// same dispute.
export const raiseSchema = z.object({
  jobId: z.string(),
  reason: z.string().min(10).max(1000),
});

disputesRouter.post("/", requireAuth, validate(raiseSchema), async (req, res, next) => {
  try {
    const { jobId, reason } = req.body as z.infer<typeof raiseSchema>;

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { client: true, freelancer: true },
    });
    if (!job) throw new AppError(404, "Job not found");
    if (!job.escrowId) throw new AppError(400, "Job has no on-chain escrow yet");

    const addr = res.locals.stellarAddress;
    const isParticipant =
      job.client.stellarAddress === addr || job.freelancer?.stellarAddress === addr;
    if (!isParticipant) throw new AppError(403, "Not a participant of this job");

    // Build escrow.open_dispute tx for the client to sign. The frontend builds
    // its own (it holds the wallet), but API-first consumers need it here.
    const escrowContract = new Contract(config.ESCROW_CONTRACT_ID);
    const xdr = await buildTx(
      addr,
      escrowContract.call("open_dispute", ...buildOpenDisputeArgs(job.escrowId, addr)),
      { messages: ESCROW_ERROR_MESSAGES },
    );

    // Persist dispute record
    const dispute = await prisma.dispute.upsert({
      where: { jobId },
      create: { jobId, raisedByAddress: addr, reason, status: "PENDING" },
      update: {},
    });

    // No notification here: the dispute is not real until `raise` confirms.
    // `/:id/sync` (and the indexer's `raised` handler) sends it instead.
    res.status(201).json({ dispute, xdr });
  } catch (err) {
    next(err);
  }
});

// GET /api/disputes/:id
//
// A PENDING row is not a dispute yet — it is an intent whose transaction was
// built but may never have been submitted. It is hidden here (404, the same as
// a missing row) so a user-visible read can never report a dispute that never
// happened (#32). Once `onChainId` is set the row is visible.
disputesRouter.get("/:id", async (req, res, next) => {
  try {
    const dispute = await prisma.dispute.findFirst({
      where: { id: req.params.id, onChainId: { not: null } },
      include: { job: true },
    });
    if (!dispute) throw new AppError(404, "Dispute not found");
    res.json(dispute);
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/evidence — a party adds a note and/or attachment (#78).
//
// Only while the dispute is RAISED: PENDING is not a dispute yet, and once the
// panel is reviewing (UNDER_REVIEW) or has ruled, the record is closed. Only the
// job's two participants may write, mirroring who may raise the dispute.
disputesRouter.post(
  "/:id/evidence",
  requireAuth,
  validate(evidenceSchema),
  async (req, res, next) => {
    try {
      const addr = res.locals.stellarAddress;
      const dispute = await loadDispute(req.params.id);
      assertParticipant(dispute, addr);

      if (!dispute.onChainId) {
        throw new AppError(409, "Dispute is not on-chain yet");
      }
      if (dispute.status !== "RAISED") {
        throw new AppError(409, "Evidence can only be added before arbitration");
      }

      const author = await prisma.user.findUnique({
        where: { stellarAddress: addr },
        select: { id: true },
      });
      if (!author) throw new AppError(404, "User not found — call /api/users/auth first");

      const { note, fileName, fileUrl, fileSize, fileType } = req.body as z.infer<
        typeof evidenceSchema
      >;

      const evidence = await prisma.disputeEvidence.create({
        data: {
          disputeId: dispute.id,
          authorId: author.id,
          note: note ?? null,
          fileName: fileName ?? null,
          fileUrl: fileUrl ?? null,
          fileSize: fileSize ?? null,
          fileType: fileType ?? null,
        },
        include: { author: evidenceAuthor },
      });

      res.status(201).json(evidence);
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/disputes/:id/evidence — what the panel reads before ruling (#78).
//
// Restricted to the two parties and the configured arbitrators: attachments can
// be private work product, so this endpoint does not inherit the public read of
// the dispute row itself. A panel allowlist that is empty grants nobody access
// (the same fail-closed rule as `/:id/resolve`).
disputesRouter.get("/:id/evidence", requireAuth, async (req, res, next) => {
  try {
    const addr = res.locals.stellarAddress;
    const dispute = await loadDispute(req.params.id);

    const isParty =
      dispute.job.client.stellarAddress === addr ||
      dispute.job.freelancer?.stellarAddress === addr;
    if (!isParty && !(await isArbitrator(addr))) {
      throw new AppError(403, "Only the parties or an arbitrator can view this evidence");
    }

    // Same invisibility rule as the dispute detail: a built-but-never-submitted
    // dispute has no evidence to show.
    if (!dispute.onChainId) throw new AppError(404, "Dispute not found");

    const evidence = await prisma.disputeEvidence.findMany({
      where: { disputeId: dispute.id },
      include: { author: evidenceAuthor },
      orderBy: { createdAt: "asc" },
    });
    res.json(evidence);
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/raise
//
// Step 2 of the sequence: build `dispute.raise` for the caller to sign once
// `open_dispute` has confirmed. The reason comes from the stored row, so the
// string the panel reads and the string the contract received cannot drift.
disputesRouter.post("/:id/raise", requireAuth, async (req, res, next) => {
  try {
    const addr = res.locals.stellarAddress;
    const dispute = await loadDispute(req.params.id);
    assertParticipant(dispute, addr);

    if (!dispute.job.escrowId) throw new AppError(400, "Job has no on-chain escrow yet");
    if (dispute.onChainId) throw new AppError(409, "This dispute already exists on-chain");

    const disputeContract = new Contract(config.DISPUTE_CONTRACT_ID);
    const xdr = await buildTx(
      addr,
      disputeContract.call(
        "raise",
        ...buildRaiseArgs(
          dispute.job.escrowId,
          config.ESCROW_CONTRACT_ID,
          addr,
          dispute.reason,
        ),
      ),
      { messages: DISPUTE_ERROR_MESSAGES },
    );

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/sync
//
// Called after `dispute.raise` confirms, with the id the contract returned.
// The indexer reaches the same conclusion from the `raised` event, so this is
// not the only writer — it just makes the id available to `/:id/resolve`
// immediately instead of whenever the next poll lands.
//
// This is the confirmation that turns a PENDING intent into a real dispute:
// it records the id, moves the row to RAISED, and sends the notification that
// `POST /` deliberately withheld. Idempotent for the same id, so a retry or an
// indexer race does not double-notify or fail.
export const syncSchema = z.object({
  onChainId: z.number().int().nonnegative(),
});

disputesRouter.post("/:id/sync", requireAuth, validate(syncSchema), async (req, res, next) => {
  try {
    const addr = res.locals.stellarAddress;
    const dispute = await loadDispute(req.params.id);
    assertParticipant(dispute, addr);

    const { onChainId } = req.body as z.infer<typeof syncSchema>;
    const id = BigInt(onChainId);

    // A different id means this row already belongs to another on-chain
    // dispute; the same id is a retry and is answered with the stored row.
    if (dispute.onChainId !== null) {
      if (dispute.onChainId === id) {
        res.json(dispute);
        return;
      }
      throw new AppError(409, "This dispute is already on-chain with a different id");
    }

    const updated = await prisma.dispute.update({
      where: { id: dispute.id },
      data: { onChainId: id, status: "RAISED" },
    });

    try {
      await notifyDisputeOpened(dispute.job, { reason: dispute.reason });
    } catch (notifyErr) {
      console.error("[notifications] Failed to send dispute notification:", notifyErr);
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/approve  (panel member only)
//
// Multi-arbitrator flow: each panel member calls `dispute.approve` with the
// split they back, and `arbitrate` only succeeds once `threshold` members have
// approved that same split. The caller is always the arbitrator on the call —
// the contract requires that address's own signature, so it is never taken from
// the request body. Unlike `/resolve` this writes nothing to the DB: one vote
// does not change the dispute, and the indexer records the final outcome.
export const approveSchema = z.object({
  clientShare: z.number().min(0),
  freelancerShare: z.number().min(0),
});

disputesRouter.post("/:id/approve", requireAuth, validate(approveSchema), async (req, res, next) => {
  try {
    const { clientShare, freelancerShare } = req.body as z.infer<typeof approveSchema>;
    const arbitrator = res.locals.stellarAddress;

    // Fail closed: an empty panel grants nobody access.
    const panel = await getArbitratorPanel();
    if (panel.length === 0) {
      throw new AppError(503, "Dispute approval is unavailable: no arbitrator panel configured");
    }
    if (!isListed(arbitrator, panel)) {
      throw new AppError(403, "Only an arbitrator panel member can approve a dispute");
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: req.params.id },
      include: { job: true },
    });
    if (!dispute) throw new AppError(404, "Dispute not found");
    if (!dispute.onChainId) {
      throw new AppError(
        409,
        "Dispute is not on-chain yet: call POST /api/disputes/:id/raise, submit it, then POST /:id/sync",
      );
    }
    // The contract accepts votes only while the dispute is open.
    if (dispute.status !== "RAISED" && dispute.status !== "UNDER_REVIEW") {
      throw new AppError(409, "Dispute is already closed and can no longer be voted on");
    }

    const asset = assetForJob(dispute.job.asset);
    const disputeContract = new Contract(config.DISPUTE_CONTRACT_ID);
    const xdr = await buildTx(
      arbitrator,
      disputeContract.call(
        "approve",
        ...buildApproveArgs(
          dispute.onChainId,
          arbitrator,
          toBaseUnits(clientShare, asset.decimals),
          toBaseUnits(freelancerShare, asset.decimals),
        ),
      ),
      { messages: DISPUTE_ERROR_MESSAGES },
    );

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});

// POST /api/disputes/:id/resolve  (arbitrator only)
export const resolveSchema = z.object({
  clientShare: z.number().min(0),
  freelancerShare: z.number().min(0),
});

disputesRouter.post("/:id/resolve", requireAuth, validate(resolveSchema), async (req, res, next) => {
  try {
    const { clientShare, freelancerShare } = req.body as z.infer<typeof resolveSchema>;

    // Fail closed: an empty panel grants nobody access.
    const arbitrators = await getArbitratorPanel();
    if (arbitrators.length === 0) {
      throw new AppError(
        503,
        "Dispute resolution is unavailable: no arbitrator panel configured",
      );
    }
    if (!isListed(res.locals.stellarAddress, arbitrators)) {
      throw new AppError(403, "Only a configured arbitrator can resolve a dispute");
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id: req.params.id },
      include: { job: true },
    });
    if (!dispute) throw new AppError(404, "Dispute not found");
    // Set by `/:id/sync` or by the indexer's `raised` handler. Until then the
    // contract has no dispute to arbitrate.
    if (!dispute.onChainId) {
      throw new AppError(
        409,
        "Dispute is not on-chain yet: call POST /api/disputes/:id/raise, submit it, then POST /:id/sync",
      );
    }

    // Build dispute.arbitrate tx. The shares are whole units of the job's
    // asset, so they are converted at that asset's decimals — USDC and XLM are
    // 7-decimal, but hardcoding 1e7 would mis-encode any asset that is not.
    const asset = assetForJob(dispute.job.asset);
    const disputeContract = new Contract(config.DISPUTE_CONTRACT_ID);
    const xdr = await buildTx(
      res.locals.stellarAddress,
      disputeContract.call(
        "arbitrate",
        ...buildArbitrateArgs(
          dispute.onChainId,
          toBaseUnits(clientShare, asset.decimals),
          toBaseUnits(freelancerShare, asset.decimals),
        ),
      ),
      { messages: DISPUTE_ERROR_MESSAGES },
    );

    // Update DB (final status set by indexer after tx confirmed)
    await prisma.dispute.update({
      where: { id: req.params.id },
      data: { status: "UNDER_REVIEW", clientShare, freelancerShare },
    });

    res.json({ xdr });
  } catch (err) {
    next(err);
  }
});
