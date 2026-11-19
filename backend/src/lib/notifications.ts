/**
 * notifications.ts
 *
 * Email notifications for key escrow lifecycle events (issue #67):
 * - Dispute opened
 * - Milestone released
 * - Escrow refunded
 *
 * Provides an EmailProvider interface with a LoggingEmailProvider fallback in dev/test.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  sendEmail(message: EmailMessage): Promise<void>;
}

export class LoggingEmailProvider implements EmailProvider {
  public sentEmails: EmailMessage[] = [];

  async sendEmail(message: EmailMessage): Promise<void> {
    this.sentEmails.push(message);
    console.log(
      `[EmailProvider:Logging] To: ${message.to} | Subject: ${message.subject} | Text: ${message.text}`,
    );
  }
}

export interface SmtpProviderOptions {
  host: string;
  port?: number;
  user?: string;
  pass?: string;
  from: string;
  secure?: boolean;
}

export class SmtpEmailProvider implements EmailProvider {
  public transporter: Transporter;
  public defaultFrom: string;

  constructor(options: SmtpProviderOptions, transporter?: Transporter) {
    this.defaultFrom = options.from;
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port ?? 587,
        secure: options.secure ?? (options.port === 465),
        auth:
          options.user && options.pass
            ? {
                user: options.user,
                pass: options.pass,
              }
            : undefined,
      });
  }

  async sendEmail(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.defaultFrom,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (err) {
      console.error(`[EmailProvider:SMTP] Failed to send email to ${message.to}:`, err);
      throw err;
    }
  }
}

export function createEmailProvider(customConfig?: Partial<typeof config>): EmailProvider {
  const c = customConfig ?? config;
  if (c?.SMTP_HOST && c?.SMTP_FROM) {
    return new SmtpEmailProvider({
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      user: c.SMTP_USER || undefined,
      pass: c.SMTP_PASS || undefined,
      from: c.SMTP_FROM,
      secure: c.SMTP_SECURE === "true" || c.SMTP_PORT === 465,
    });
  }
  return new LoggingEmailProvider();
}

let activeEmailProvider: EmailProvider = createEmailProvider();

export function getEmailProvider(): EmailProvider {
  return activeEmailProvider;
}

export function setEmailProvider(provider: EmailProvider): void {
  activeEmailProvider = provider;
}

/**
 * Truncate or mask a 56-character Stellar public address (e.g. `GA3F...7B29` or `GABCD...WXYZ`).
 * If the string is shorter than or equal to 10 characters, returns it unchanged.
 */
export function shortAddress(address: string): string {
  if (!address || address.length <= 10) return address;
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

/**
 * Scan a string and replace any full 56-character Stellar public keys (e.g. `G...`)
 * with their masked representation (`shortAddress`).
 */
export function maskAddresses(text: string): string {
  if (!text) return text;
  return text.replace(/\b[GCM][A-Z2-7]{55}\b/g, (match) => shortAddress(match));
}

export interface NotificationUser {
  id?: string;
  stellarAddress: string;
  displayName?: string | null;
  email?: string | null;
  notifyOnDispute?: boolean;
  notifyOnRelease?: boolean;
  notifyOnRefund?: boolean;
  notifyOnProposal?: boolean;
  notifyOnAssignment?: boolean;
}

export interface NotificationProposal {
  id?: string;
  coverLetter?: string | null;
  proposedRate?: string | number | { toString(): string } | null;
}

export interface NotificationJob {
  id: string;
  title: string;
  client?: NotificationUser | null;
  freelancer?: NotificationUser | null;
}

/**
 * Dispatches an email notification when a dispute is opened.
 * Only sends to participants who have an email set and have opted in (`notifyOnDispute: true`).
 */
export async function notifyDisputeOpened(
  job: NotificationJob,
  details?: { reason?: string; disputeId?: string },
): Promise<void> {
  const provider = getEmailProvider();
  const parties = [job.client, job.freelancer].filter(
    (u): u is NotificationUser => Boolean(u && u.email && u.notifyOnDispute),
  );

  const maskedTitle = maskAddresses(job.title);
  const maskedReason = details?.reason ? maskAddresses(details.reason) : "";

  for (const party of parties) {
    const text = [
      `Hello,`,
      ``,
      `A dispute has been opened for the job "${maskedTitle}".`,
      maskedReason ? `Reason: ${maskedReason}` : "",
      details?.disputeId ? `Dispute ID: ${details.disputeId}` : "",
      ``,
      `Please visit the platform to review and take action.`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await provider.sendEmail({
        to: party.email!,
        subject: maskAddresses(`[Notification] Dispute Opened: ${job.title}`),
        text,
      });
    } catch (err) {
      console.error(`[notifications] Failed to send dispute email to ${party.email}:`, err);
    }
  }
}

/**
 * Dispatches an email notification when a milestone is released.
 * Only sends to participants who have an email set and have opted in (`notifyOnRelease: true`).
 */
export async function notifyMilestoneReleased(
  job: NotificationJob,
  milestone: { index: number; amount?: string | number },
): Promise<void> {
  const provider = getEmailProvider();
  const parties = [job.client, job.freelancer].filter(
    (u): u is NotificationUser => Boolean(u && u.email && u.notifyOnRelease),
  );

  const maskedTitle = maskAddresses(job.title);

  for (const party of parties) {
    const text = [
      `Hello,`,
      ``,
      `Milestone #${milestone.index + 1} for the job "${maskedTitle}" has been released!`,
      milestone.amount ? `Amount: ${milestone.amount}` : "",
      ``,
      `Please visit the platform to review the updated job status.`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await provider.sendEmail({
        to: party.email!,
        subject: maskAddresses(`[Notification] Milestone Released: ${job.title}`),
        text,
      });
    } catch (err) {
      console.error(`[notifications] Failed to send milestone released email to ${party.email}:`, err);
    }
  }
}

/**
 * Dispatches an email notification when an escrow is refunded.
 * Only sends to participants who have an email set and have opted in (`notifyOnRefund: true`).
 */
export async function notifyEscrowRefunded(
  job: NotificationJob,
  details?: { reason?: string },
): Promise<void> {
  const provider = getEmailProvider();
  const parties = [job.client, job.freelancer].filter(
    (u): u is NotificationUser => Boolean(u && u.email && u.notifyOnRefund),
  );

  const maskedTitle = maskAddresses(job.title);
  const maskedDetails = details?.reason ? maskAddresses(details.reason) : "";

  for (const party of parties) {
    const text = [
      `Hello,`,
      ``,
      `The escrow for the job "${maskedTitle}" has been refunded.`,
      maskedDetails ? `Details: ${maskedDetails}` : "",
      ``,
      `Please visit the platform to review the updated job status.`,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await provider.sendEmail({
        to: party.email!,
        subject: maskAddresses(`[Notification] Escrow Refunded: ${job.title}`),
        text,
      });
    } catch (err) {
      console.error(`[notifications] Failed to send escrow refunded email to ${party.email}:`, err);
    }
  }
}

/**
 * Dispatches an email notification when a new proposal is submitted on a job (issue #249).
 * Only sends to the client if they have an email set and have opted in (`notifyOnProposal: true`).
 */
export async function notifyProposalSubmitted(
  job: NotificationJob,
  proposal: NotificationProposal,
  freelancer: NotificationUser,
): Promise<void> {
  const provider = getEmailProvider();
  const client = job.client;
  if (!client || !client.email || !client.notifyOnProposal) {
    return;
  }

  const maskedTitle = maskAddresses(job.title);
  const maskedFreelancer = maskAddresses(
    freelancer.displayName
      ? `${freelancer.displayName} (${shortAddress(freelancer.stellarAddress)})`
      : shortAddress(freelancer.stellarAddress),
  );
  const maskedCover = proposal.coverLetter ? maskAddresses(proposal.coverLetter) : "";

  const text = [
    `Hello,`,
    ``,
    `A new proposal has been submitted for your job "${maskedTitle}".`,
    `Freelancer: ${maskedFreelancer}`,
    proposal.proposedRate ? `Proposed Rate: ${proposal.proposedRate.toString()}` : "",
    maskedCover ? `Cover Letter: ${maskedCover}` : "",
    ``,
    `Please visit the platform to review the proposal and take action.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await provider.sendEmail({
      to: client.email,
      subject: maskAddresses(`[Notification] New Proposal: ${job.title}`),
      text,
    });
  } catch (err) {
    console.error(`[notifications] Failed to send proposal notification email to ${client.email}:`, err);
  }
}

/**
 * Dispatches an email notification when a freelancer is assigned to a job (issue #249).
 * Only sends to the freelancer if they have an email set and have opted in (`notifyOnAssignment: true`).
 */
export async function notifyJobAssigned(
  job: NotificationJob,
  freelancer: NotificationUser,
): Promise<void> {
  const provider = getEmailProvider();
  if (!freelancer || !freelancer.email || !freelancer.notifyOnAssignment) {
    return;
  }

  const maskedTitle = maskAddresses(job.title);
  const maskedClient = job.client
    ? maskAddresses(
        job.client.displayName
          ? `${job.client.displayName} (${shortAddress(job.client.stellarAddress)})`
          : shortAddress(job.client.stellarAddress),
      )
    : "The client";

  const text = [
    `Hello,`,
    ``,
    `You have been assigned to the job "${maskedTitle}"!`,
    `Client: ${maskedClient}`,
    ``,
    `Please visit the platform to review the job details and milestones.`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await provider.sendEmail({
      to: freelancer.email,
      subject: maskAddresses(`[Notification] Job Assigned: ${job.title}`),
      text,
    });
  } catch (err) {
    console.error(`[notifications] Failed to send job assignment email to ${freelancer.email}:`, err);
  }
}
