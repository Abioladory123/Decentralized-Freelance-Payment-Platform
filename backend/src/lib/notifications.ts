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

let activeEmailProvider: EmailProvider = new LoggingEmailProvider();

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
  email?: string | null;
  notifyOnDispute?: boolean;
  notifyOnRelease?: boolean;
  notifyOnRefund?: boolean;
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

    await provider.sendEmail({
      to: party.email!,
      subject: maskAddresses(`[Notification] Dispute Opened: ${job.title}`),
      text,
    });
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

    await provider.sendEmail({
      to: party.email!,
      subject: maskAddresses(`[Notification] Milestone Released: ${job.title}`),
      text,
    });
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

    await provider.sendEmail({
      to: party.email!,
      subject: maskAddresses(`[Notification] Escrow Refunded: ${job.title}`),
      text,
    });
  }
}
