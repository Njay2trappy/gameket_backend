import { randomUUID } from "crypto";
import { getDB } from "./db.js";
import { logger } from "./logger.js";

const AUDIT_EVENT_NAMES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILURE",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "WITHDRAWAL_REQUESTED",
  "WITHDRAWAL_APPROVED",
  "WITHDRAWAL_DECLINED",
  "ADMIN_ACTION",
] as const;

const AUDIT_CATEGORIES = ["auth", "password_reset", "withdrawal", "admin_action"] as const;
const AUDIT_OUTCOMES = ["success", "failure"] as const;
const AUDIT_ACTOR_TYPES = ["anonymous", "user", "admin", "system"] as const;

export type AuditEventName = typeof AUDIT_EVENT_NAMES[number];
export type AuditCategory = typeof AUDIT_CATEGORIES[number];
export type AuditOutcome = typeof AUDIT_OUTCOMES[number];
export type AuditActorType = typeof AUDIT_ACTOR_TYPES[number];

export type AuditEventInput = {
  eventName: AuditEventName;
  category: AuditCategory;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  requestId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
};

type AuditLogDocument = {
  auditId: string;
  eventName: AuditEventName;
  category: AuditCategory;
  outcome: AuditOutcome;
  actorType: AuditActorType;
  actorId: string | null;
  requestId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

const CATEGORY_BY_EVENT: Record<AuditEventName, AuditCategory> = {
  LOGIN_SUCCESS: "auth",
  LOGIN_FAILURE: "auth",
  PASSWORD_RESET_REQUESTED: "password_reset",
  PASSWORD_RESET_COMPLETED: "password_reset",
  WITHDRAWAL_REQUESTED: "withdrawal",
  WITHDRAWAL_APPROVED: "withdrawal",
  WITHDRAWAL_DECLINED: "withdrawal",
  ADMIN_ACTION: "admin_action",
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const sanitizeMetadata = (metadata: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!metadata) {
    return {};
  }

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      clean[key] = value;
    }
  }
  return clean;
};

const assertAuditInput = (input: AuditEventInput): void => {
  if (!AUDIT_EVENT_NAMES.includes(input.eventName)) {
    throw new Error(`Unsupported audit event name: ${input.eventName}`);
  }

  if (!AUDIT_CATEGORIES.includes(input.category)) {
    throw new Error(`Unsupported audit category: ${input.category}`);
  }

  const expectedCategory = CATEGORY_BY_EVENT[input.eventName];
  if (input.category !== expectedCategory) {
    throw new Error(`Invalid category ${input.category} for event ${input.eventName}`);
  }

  if (!AUDIT_OUTCOMES.includes(input.outcome)) {
    throw new Error(`Unsupported audit outcome: ${input.outcome}`);
  }

  if (!AUDIT_ACTOR_TYPES.includes(input.actorType)) {
    throw new Error(`Unsupported audit actor type: ${input.actorType}`);
  }

  if (input.actorId !== null && typeof input.actorId !== "string") {
    throw new Error("actorId must be a string or null");
  }

  if (input.requestId !== undefined && input.requestId !== null && typeof input.requestId !== "string") {
    throw new Error("requestId must be a string, null, or undefined");
  }

  if (input.targetType !== undefined && input.targetType !== null && typeof input.targetType !== "string") {
    throw new Error("targetType must be a string, null, or undefined");
  }

  if (input.targetId !== undefined && input.targetId !== null && typeof input.targetId !== "string") {
    throw new Error("targetId must be a string, null, or undefined");
  }

  if (input.metadata !== undefined && !isPlainObject(input.metadata)) {
    throw new Error("metadata must be a plain object when provided");
  }
};

export const recordAuditEvent = async (input: AuditEventInput): Promise<void> => {
  try {
    assertAuditInput(input);

    const now = new Date().toISOString();
    const doc: AuditLogDocument = {
      auditId: randomUUID(),
      eventName: input.eventName,
      category: input.category,
      outcome: input.outcome,
      actorType: input.actorType,
      actorId: input.actorId,
      requestId: input.requestId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: sanitizeMetadata(input.metadata),
      createdAt: now,
    };

    // Append-only by design: audit entries are only inserted, never updated/deleted.
    await getDB().collection<AuditLogDocument>("AuditLogs").insertOne(doc);
  } catch (err) {
    logger.error({ err, eventName: input.eventName }, "Failed to record audit event");
  }
};
