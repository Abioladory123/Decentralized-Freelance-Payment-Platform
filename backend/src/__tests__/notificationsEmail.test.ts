import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EmailProvider,
  EmailMessage,
  LoggingEmailProvider,
  SmtpEmailProvider,
  createEmailProvider,
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

  describe("SmtpEmailProvider (Issue #247)", () => {
    it("dispatches emails via SMTP transporter when configured", async () => {
      const sendMailMock = vi.fn().mockResolvedValue({ messageId: "msg-123" });
      const fakeTransporter = {
        sendMail: sendMailMock,
      } as any;

      const smtpProvider = new SmtpEmailProvider(
        {
          host: "smtp.example.com",
          port: 587,
          user: "user@example.com",
          pass: "secret",
          from: "noreply@example.com",
          secure: false,
        },
        fakeTransporter,
      );

      await smtpProvider.sendEmail({
        to: "recipient@example.com",
        subject: "Dispute Update",
        text: "Please review dispute",
        html: "<p>Please review dispute</p>",
      });

      expect(sendMailMock).toHaveBeenCalledTimes(1);
      expect(sendMailMock).toHaveBeenCalledWith({
        from: "noreply@example.com",
        to: "recipient@example.com",
        subject: "Dispute Update",
        text: "Please review dispute",
        html: "<p>Please review dispute</p>",
      });
    });

    it("throws when transporter fails to deliver email", async () => {
      const sendMailMock = vi.fn().mockRejectedValue(new Error("SMTP connection failed"));
      const fakeTransporter = {
        sendMail: sendMailMock,
      } as any;

      const smtpProvider = new SmtpEmailProvider(
        {
          host: "smtp.example.com",
          from: "noreply@example.com",
        },
        fakeTransporter,
      );

      await expect(
        smtpProvider.sendEmail({
          to: "recipient@example.com",
          subject: "Test",
          text: "Test",
        }),
      ).rejects.toThrow("SMTP connection failed");
    });

    it("initializes SmtpEmailProvider when SMTP credentials are present in config", () => {
      const provider = createEmailProvider({
        SMTP_HOST: "smtp.sendgrid.net",
        SMTP_PORT: 587,
        SMTP_USER: "apikey",
        SMTP_PASS: "SG.12345",
        SMTP_FROM: "no-reply@platform.io",
      } as any);

      expect(provider).toBeInstanceOf(SmtpEmailProvider);
      expect((provider as SmtpEmailProvider).defaultFrom).toBe("no-reply@platform.io");
    });

    it("falls back cleanly to LoggingEmailProvider when SMTP credentials are missing", () => {
      const provider = createEmailProvider({
        SMTP_HOST: "",
        SMTP_FROM: "",
      } as any);

      expect(provider).toBeInstanceOf(LoggingEmailProvider);
    });

    it("prevents notification failures from throwing or interrupting API caller", async () => {
      const failingProvider: EmailProvider = {
        sendEmail: vi.fn().mockRejectedValue(new Error("Network timeout")),
      };
      setEmailProvider(failingProvider);

      const job: NotificationJob = {
        id: "job_err",
        title: "Test Job",
        client: {
          stellarAddress: "GCLIENT",
          email: "client@example.com",
          notifyOnDispute: true,
          notifyOnRelease: true,
          notifyOnRefund: true,
        },
      };

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // All three should resolve without throwing
      await expect(notifyDisputeOpened(job, { reason: "test" })).resolves.not.toThrow();
      await expect(notifyMilestoneReleased(job, { index: 0, amount: "100" })).resolves.not.toThrow();
      await expect(notifyEscrowRefunded(job, { reason: "test" })).resolves.not.toThrow();

      expect(errSpy).toHaveBeenCalledTimes(3);
      errSpy.mockRestore();
    });
  });
});
