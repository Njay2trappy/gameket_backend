import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import pino from "pino";

type RequestWithId = Request & { requestId?: string };

const defaultLogLevel = process.env.NODE_ENV === "production" ? "info" : "debug";

export const logger = pino({
  level: process.env.LOG_LEVEL || defaultLogLevel,
  base: {
    service: "gameket-backend",
    env: process.env.NODE_ENV || "development",
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.adminauthorization",
      "password",
      "token",
      "twoFactorToken",
      "otp",
    ],
    remove: true,
  },
});

const getIncomingRequestId = (req: Request): string | null => {
  const requestIdHeader = req.headers["x-request-id"];
  if (Array.isArray(requestIdHeader)) {
    return requestIdHeader[0] || null;
  }
  return requestIdHeader || null;
};

export const attachRequestId = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = getIncomingRequestId(req) || randomUUID();
  (req as RequestWithId).requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
};

export const getRequestId = (req: Request): string => {
  return (req as RequestWithId).requestId || getIncomingRequestId(req) || "unknown";
};
