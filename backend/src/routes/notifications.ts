/**
 * notifications.ts
 *
 * Persistent notifications for escrow and dispute events (#66).
 *
 * GET   /api/notifications           — get notifications for the authenticated user
 * PATCH /api/notifications/:id/read  — mark single notification as read
 * PATCH /api/notifications/read-all  — mark all notifications as read
 */

import { Router } from "express";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";

export const notificationsRouter = Router();

// GET /api/notifications
notificationsRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!user) throw new AppError(404, "User not found");

    const unreadOnly = req.query.unread === "true";

    let limit = 50;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(String(req.query.limit), 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        throw new AppError(400, "Invalid limit parameter");
      }
      limit = Math.min(parsedLimit, 100);
    }

    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor.trim() !== ""
        ? req.query.cursor.trim()
        : undefined;

    const [rawNotifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId: user.id,
          ...(unreadOnly ? { read: false } : {}),
        },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { createdAt: "desc" },
        take: limit + 1,
      }),
      prisma.notification.count({
        where: { userId: user.id, read: false },
      }),
    ]);

    let nextCursor: string | null = null;
    const notifications = [...rawNotifications];
    if (notifications.length > limit) {
      notifications.pop();
      nextCursor = notifications[notifications.length - 1]?.id ?? null;
    }

    res.json({ notifications, unreadCount, nextCursor });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read
notificationsRouter.patch("/:id/read", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!user) throw new AppError(404, "User not found");

    const notification = await prisma.notification.findUnique({
      where: { id: req.params.id },
    });
    if (!notification || notification.userId !== user.id) {
      throw new AppError(404, "Notification not found");
    }

    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: { read: true },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all
notificationsRouter.patch("/read-all", requireAuth, async (_req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { stellarAddress: res.locals.stellarAddress },
    });
    if (!user) throw new AppError(404, "User not found");

    await prisma.notification.updateMany({
      where: { userId: user.id, read: false },
      data: { read: true },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
