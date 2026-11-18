import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { SignJWT } from "jose";

const JWT_SECRET = "test-secret-at-least-32-chars-long-for-tests";
process.env.JWT_SECRET = JWT_SECRET;
process.env.DATABASE_URL = "postgresql://unused:unused@localhost:5432/unused";

interface FakeUser {
  id: string;
  stellarAddress: string;
}

interface FakeNotification {
  id: string;
  userId: string;
  jobId: string | null;
  type: "FUNDED" | "RELEASED" | "DISPUTED" | "RESOLVED";
  title: string;
  message: string;
  read: boolean;
  createdAt: Date;
}

const fakeUsers: FakeUser[] = [];
const fakeNotifications: FakeNotification[] = [];

vi.mock("../db", () => {
  return {
    prisma: {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { stellarAddress?: string; id?: string } }) => {
          if (where.stellarAddress) {
            const user = fakeUsers.find((u) => u.stellarAddress === where.stellarAddress);
            // `requireAuth` reads the current session alongside the user row.
            return user ? { ...user, sessions: [] } : null;
          }
          if (where.id) {
            const user = fakeUsers.find((u) => u.id === where.id);
            return user ? { ...user, sessions: [] } : null;
          }
          return null;
        }),
      },
      notification: {
        findMany: vi.fn(async ({
          where,
          cursor,
          skip,
          take,
        }: {
          where: { userId: string; read?: boolean };
          cursor?: { id: string };
          skip?: number;
          take?: number;
          orderBy?: { createdAt: "asc" | "desc" };
        }) => {
          let list = fakeNotifications.filter((n) => {
            if (n.userId !== where.userId) return false;
            if (where.read !== undefined && n.read !== where.read) return false;
            return true;
          });

          // Sort by createdAt descending
          list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

          if (cursor) {
            const index = list.findIndex((n) => n.id === cursor.id);
            if (index !== -1) {
              const start = index + (skip ?? 0);
              list = list.slice(start);
            }
          }

          if (take !== undefined) {
            list = list.slice(0, take);
          }

          return list;
        }),
        count: vi.fn(async ({ where }: { where: { userId: string; read?: boolean } }) => {
          return fakeNotifications.filter((n) => {
            if (n.userId !== where.userId) return false;
            if (where.read !== undefined && n.read !== where.read) return false;
            return true;
          }).length;
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return fakeNotifications.find((n) => n.id === where.id) ?? null;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: { read: boolean } }) => {
          const notif = fakeNotifications.find((n) => n.id === where.id);
          if (notif) notif.read = data.read;
          return notif;
        }),
        updateMany: vi.fn(async ({ where, data }: { where: { userId: string; read?: boolean }; data: { read: boolean } }) => {
          let count = 0;
          for (const n of fakeNotifications) {
            if (n.userId === where.userId && (where.read === undefined || n.read === where.read)) {
              n.read = data.read;
              count++;
            }
          }
          return { count };
        }),
        create: vi.fn(async ({ data }: { data: Omit<FakeNotification, "id" | "createdAt" | "read"> }) => {
          const notif: FakeNotification = {
            id: `notif-${fakeNotifications.length + 1}`,
            read: false,
            createdAt: new Date(),
            ...data,
          };
          fakeNotifications.push(notif);
          return notif;
        }),
      },
      job: {
        findUnique: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      dispute: {
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    },
  };
});

let baseUrl: string;
let server: Server;

beforeAll(async () => {
  const { notificationsRouter } = await import("../routes/notifications");
  const { errorHandler } = await import("../middleware/errorHandler");

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  fakeUsers.length = 0;
  fakeNotifications.length = 0;
});

async function makeToken(address: string): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET);
  return new SignJWT({ sub: address })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(secret);
}

describe("Notifications API (#66)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${baseUrl}/api/notifications`);
    expect(res.status).toBe(401);
  });

  it("returns notifications and unreadCount for the authenticated user", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n1",
      userId: "u1",
      jobId: "job-1",
      type: "FUNDED",
      title: "Escrow Funded",
      message: "Escrow has been funded.",
      read: false,
      createdAt: new Date(),
    });
    fakeNotifications.push({
      id: "n2",
      userId: "u1",
      jobId: "job-1",
      type: "RELEASED",
      title: "Milestone Released",
      message: "Milestone 1 released.",
      read: true,
      createdAt: new Date(),
    });
    // Another user's notification should not leak
    fakeNotifications.push({
      id: "n3",
      userId: "u2",
      jobId: "job-2",
      type: "DISPUTED",
      title: "Dispute Opened",
      message: "Dispute opened.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      notifications: FakeNotification[];
      unreadCount: number;
    };
    expect(body.notifications).toHaveLength(2);
    expect(body.unreadCount).toBe(1);
    expect(body.notifications[0]?.title).toBe("Escrow Funded");
  });

  it("marks a single notification as read", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n1",
      userId: "u1",
      jobId: "job-1",
      type: "DISPUTED",
      title: "Dispute Opened",
      message: "Dispute opened.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/n1/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FakeNotification;
    expect(body.read).toBe(true);
    expect(fakeNotifications[0]?.read).toBe(true);
  });

  it("rejects marking another user's notification as read with 404", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push({
      id: "n2",
      userId: "u2", // belongs to u2
      jobId: "job-1",
      type: "RESOLVED",
      title: "Dispute Resolved",
      message: "Resolved.",
      read: false,
      createdAt: new Date(),
    });

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/n2/read`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  it("marks all notifications as read for the user", async () => {
    const user: FakeUser = {
      id: "u1",
      stellarAddress: "GBTESTUSER11111111111111111111111111111111111111111111111",
    };
    fakeUsers.push(user);
    fakeNotifications.push(
      {
        id: "n1",
        userId: "u1",
        jobId: "j1",
        type: "FUNDED",
        title: "T1",
        message: "M1",
        read: false,
        createdAt: new Date(),
      },
      {
        id: "n2",
        userId: "u1",
        jobId: "j2",
        type: "RESOLVED",
        title: "T2",
        message: "M2",
        read: false,
        createdAt: new Date(),
      },
    );

    const token = await makeToken(user.stellarAddress);
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
    expect(fakeNotifications.every((n) => n.read)).toBe(true);
  });

  describe("cursor pagination (issue #248)", () => {
    it("returns nextCursor when more notifications exist beyond limit", async () => {
      const user: FakeUser = {
        id: "u_page",
        stellarAddress: "GBPAGEUSER1111111111111111111111111111111111111111111111",
      };
      fakeUsers.push(user);

      // Create 3 notifications with distinct timestamps
      const now = Date.now();
      for (let i = 1; i <= 3; i++) {
        fakeNotifications.push({
          id: `notif-page-${i}`,
          userId: user.id,
          jobId: `job-${i}`,
          type: "FUNDED",
          title: `Notification ${i}`,
          message: `Message ${i}`,
          read: false,
          createdAt: new Date(now + i * 1000), // higher i = newer
        });
      }

      const token = await makeToken(user.stellarAddress);

      // Fetch first page with limit=2 (descending order: notif-page-3, notif-page-2)
      const res = await fetch(`${baseUrl}/api/notifications?limit=2`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        notifications: FakeNotification[];
        unreadCount: number;
        nextCursor: string | null;
      };

      expect(data.notifications).toHaveLength(2);
      expect(data.notifications[0].id).toBe("notif-page-3");
      expect(data.notifications[1].id).toBe("notif-page-2");
      expect(data.nextCursor).toBe("notif-page-2");

      // Fetch second page using nextCursor
      const res2 = await fetch(`${baseUrl}/api/notifications?limit=2&cursor=${data.nextCursor}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as {
        notifications: FakeNotification[];
        unreadCount: number;
        nextCursor: string | null;
      };

      expect(data2.notifications).toHaveLength(1);
      expect(data2.notifications[0].id).toBe("notif-page-1");
      expect(data2.nextCursor).toBeNull();
    });

    it("defaults to limit=50 and returns null nextCursor when results do not exceed limit", async () => {
      const user: FakeUser = {
        id: "u_page_single",
        stellarAddress: "GBSINGLEUSER11111111111111111111111111111111111111111111",
      };
      fakeUsers.push(user);
      fakeNotifications.push({
        id: "single-notif",
        userId: user.id,
        jobId: "j1",
        type: "RESOLVED",
        title: "Single",
        message: "Single",
        read: false,
        createdAt: new Date(),
      });

      const token = await makeToken(user.stellarAddress);
      const res = await fetch(`${baseUrl}/api/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        notifications: FakeNotification[];
        unreadCount: number;
        nextCursor: string | null;
      };

      expect(data.notifications).toHaveLength(1);
      expect(data.nextCursor).toBeNull();
    });

    it("rejects invalid limit parameter with 400", async () => {
      const user: FakeUser = {
        id: "u_invalid",
        stellarAddress: "GBINVALIDUSER1111111111111111111111111111111111111111111",
      };
      fakeUsers.push(user);

      const token = await makeToken(user.stellarAddress);
      const res = await fetch(`${baseUrl}/api/notifications?limit=-5`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
    });
  });
});
