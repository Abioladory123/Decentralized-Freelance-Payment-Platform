import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EmailProvider,
  EmailMessage,
  LoggingEmailProvider,
  getEmailProvider,
  setEmailProvider,
  notifyDisputeOpened,
  notifyMilestoneReleased,
  notifyEscrowRefunded,
  shortAddress,
  maskAddresses,
  NotificationJob,
} from "../lib/notifications";

class TestEmailProvider implements EmailProvider {
  public sent: EmailMessage[] = [];
  async sendEmail(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("Email Notifications System (Issue #67)", () => {
  let testProvider: TestEmailProvider;

  beforeEach(() => {
    testProvider = new TestEmailProvider();
    setEmailProvider(testProvider);
  });

  describe("Provider abstraction", () => {
    it("falls back to LoggingEmailProvider in development by default", async () => {
      const loggingProvider = new LoggingEmailProvider();
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await loggingProvider.sendEmail({
        to: "alice@example.com",
        subject: "Test Subject",
        text: "Test content",
      });

      expect(loggingProvider.sentEmails).toHaveLength(1);
      expect(loggingProvider.sentEmails[0].to).toBe("alice@example.com");
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("allows registering a custom email provider", () => {
      expect(getEmailProvider()).toBe(testProvider);
    });
  });

  describe("notifyDisputeOpened", () => {
    it("sends emails only to participants with email and notifyOnDispute enabled", async () => {
      const job: NotificationJob = {
        id: "job_1",
        title: "Frontend Redesign",
        client: {
          stellarAddress: "GCLIENT",
          email: "client@example.com",
          notifyOnDispute: true,
        },
        freelancer: {
          stellarAddress: "GFREELANCER",
          email: "freelancer@example.com",
          notifyOnDispute: false, // Opted out
        },
      };

      await notifyDisputeOpened(job, { reason: "Work was not delivered on time" });

      expect(testProvider.sent).toHaveLength(1);
      expect(testProvider.sent[0].to).toBe("client@example.com");
      expect(testProvider.sent[0].subject).toContain("Dispute Opened: Frontend Redesign");
      expect(testProvider.sent[0].text).toContain("Work was not delivered on time");
    });

    it("does not send emails if no participants have opted in", async () => {
      const job: NotificationJob = {
        id: "job_1",
        title: "Frontend Redesign",
        client: {
          stellarAddress: "GCLIENT",
          email: "client@example.com",
          notifyOnDispute: false,
        },
        freelancer: {
          stellarAddress: "GFREELANCER",
          email: null,
          notifyOnDispute: true,
        },
      };

      await notifyDisputeOpened(job);

      expect(testProvider.sent).toHaveLength(0);
    });
  });

  describe("notifyMilestoneReleased", () => {
    it("sends emails only to participants with email and notifyOnRelease enabled", async () => {
      const job: NotificationJob = {
        id: "job_2",
        title: "Backend API",
        client: {
          stellarAddress: "GCLIENT",
          email: "client@example.com",
          notifyOnRelease: false,
        },
        freelancer: {
          stellarAddress: "GFREELANCER",
          email: "freelancer@example.com",
          notifyOnRelease: true,
        },
      };

      await notifyMilestoneReleased(job, { index: 1, amount: "150.00" });

      expect(testProvider.sent).toHaveLength(1);
      expect(testProvider.sent[0].to).toBe("freelancer@example.com");
      expect(testProvider.sent[0].subject).toContain("Milestone Released: Backend API");
      expect(testProvider.sent[0].text).toContain("Milestone #2");
      expect(testProvider.sent[0].text).toContain("Amount: 150.00");
    });
  });

  describe("notifyEscrowRefunded", () => {
    it("sends emails only to participants with email and notifyOnRefund enabled", async () => {
      const job: NotificationJob = {
        id: "job_3",
        title: "Logo Design",
        client: {
          stellarAddress: "GCLIENT",
          email: "client@example.com",
          notifyOnRefund: true,
        },
        freelancer: {
          stellarAddress: "GFREELANCER",
          email: "freelancer@example.com",
          notifyOnRefund: true,
        },
      };

      await notifyEscrowRefunded(job, { reason: "Dispute timeout reached" });

      expect(testProvider.sent).toHaveLength(2);
      expect(testProvider.sent[0].to).toBe("client@example.com");
      expect(testProvider.sent[1].to).toBe("freelancer@example.com");
      expect(testProvider.sent[0].subject).toContain("Escrow Refunded: Logo Design");
      expect(testProvider.sent[0].text).toContain("Dispute timeout reached");
    });
  });

  describe("Address masking and privacy (Issue #311)", () => {
    const FULL_ADDRESS = "GBPLJHDI6RPLS4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3LQ75B";

    it("shortAddress truncates 56-char address to masked format", () => {
      const masked = shortAddress(FULL_ADDRESS);
      expect(masked).toBe("GBPLJ...Q75B");
      expect(masked).toHaveLength(12);
      expect(masked).not.toContain("4EEJJTM7EVEV3UNTXLFAACWA63QSTHGLWH5RO3");
    });

    it("shortAddress preserves addresses shorter than or equal to 10 chars", () => {
      expect(shortAddress("GABC")).toBe("GABC");
      expect(shortAddress("1234567890")).toBe("1234567890");
    });

    it("maskAddresses replaces full Stellar addresses embedded in arbitrary text", () => {
      const text = `Contract between ${FULL_ADDRESS} and someone else`;
      const masked = maskAddresses(text);
      expect(masked).toBe("Contract between GBPLJ...Q75B and someone else");
      expect(masked).not.toContain(FULL_ADDRESS);
    });

    it("masks Stellar public keys in email subject lines and text bodies", async () => {
      const jobWithAddress: NotificationJob = {
        id: "job_addr",
        title: `Audit smart contract for ${FULL_ADDRESS}`,
        client: {
          stellarAddress: FULL_ADDRESS,
          email: "client@example.com",
          notifyOnDispute: true,
          notifyOnRelease: true,
          notifyOnRefund: true,
        },
      };

      // 1. Dispute Opened
      await notifyDisputeOpened(jobWithAddress, {
        reason: `Payment withheld by ${FULL_ADDRESS}`,
      });
      expect(testProvider.sent).toHaveLength(1);
      const disputeEmail = testProvider.sent[0];
      expect(disputeEmail.subject).not.toContain(FULL_ADDRESS);
      expect(disputeEmail.subject).toContain("GBPLJ...Q75B");
      expect(disputeEmail.text).not.toContain(FULL_ADDRESS);
      expect(disputeEmail.text).toContain("GBPLJ...Q75B");

      // 2. Milestone Released
      testProvider.sent = [];
      await notifyMilestoneReleased(jobWithAddress, { index: 0, amount: "500" });
      expect(testProvider.sent).toHaveLength(1);
      const releaseEmail = testProvider.sent[0];
      expect(releaseEmail.subject).not.toContain(FULL_ADDRESS);
      expect(releaseEmail.subject).toContain("GBPLJ...Q75B");
      expect(releaseEmail.text).not.toContain(FULL_ADDRESS);

      // 3. Escrow Refunded
      testProvider.sent = [];
      await notifyEscrowRefunded(jobWithAddress, {
        reason: `Refund requested for ${FULL_ADDRESS}`,
      });
      expect(testProvider.sent).toHaveLength(1);
      const refundEmail = testProvider.sent[0];
      expect(refundEmail.subject).not.toContain(FULL_ADDRESS);
      expect(refundEmail.subject).toContain("GBPLJ...Q75B");
      expect(refundEmail.text).not.toContain(FULL_ADDRESS);
      expect(refundEmail.text).toContain("GBPLJ...Q75B");
    });
  });
});
