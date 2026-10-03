import type { AuditAction, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Event kinds surfaced to the notifier. `level` drives the notification
 * channel/priority on the device so critical updates stand out.
 */
export type ChangeKind =
  | "invoice"
  | "target"
  | "stuff"
  | "employee"
  | "month"
  | "system";

export type ChangeLevel = "normal" | "important" | "critical";

export type ChangeEvent = {
  id: string;
  action: AuditAction;
  entity: string;
  entityId: string | null;
  title: string;
  body: string;
  kind: ChangeKind;
  level: ChangeLevel;
  at: string;
  details: Record<string, unknown> | null;
  /** Full value snapshots written by the routes; null for entries logged before this. */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

type AuditRow = {
  id: string;
  action: AuditAction;
  entity: string;
  entityId: string | null;
  details: unknown;
  before?: unknown;
  after?: unknown;
  createdAt: Date;
};

const money = (n: unknown) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(n) || 0);

const kindOf = (entity: string): ChangeKind => {
  const e = entity.toLowerCase();
  if (e.includes("invoice")) return "invoice";
  if (e.includes("target")) return "target";
  if (e.includes("stuff")) return "stuff";
  if (e.includes("employee")) return "employee";
  if (e === "month") return "month";
  return "system";
};

/** Deletions and month close/open are the changes that must never be missed. */
const levelOf = (action: AuditAction, kind: ChangeKind): ChangeLevel => {
  if (action === "DELETE") return "critical";
  if (kind === "target" || kind === "month") return "important";
  return "normal";
};

/**
 * Turns an AuditLog row into a human-readable, device-ready notification.
 * All labels are Arabic to match the dashboard language.
 */
export function toChangeEvent(row: AuditRow): ChangeEvent {
  const d = (row.details ?? {}) as Record<string, any>;
  const before = (row.before ?? null) as Record<string, any> | null;
  const after = (row.after ?? null) as Record<string, any> | null;
  const kind = kindOf(row.entity);
  const level = levelOf(row.action, kind);

  let title = "تحديث جديد";
  let body = "";

  switch (kind) {
    case "invoice": {
      const num = d.invoiceNumber || "فاتورة";
      if (row.action === "DELETE") {
        title = "تم حذف فاتورة";
        // `before` carries the amount, so the notification no longer hides the value
        // that was just removed — and the row itself is still recoverable.
        body = before ? `${num} · ${money(before.amount)} · يمكن استرجاعها` : num;
      } else if (row.action === "RESTORE") {
        title = "تم استرجاع فاتورة";
        body = `${num}${after ? ` · ${money(after.amount)}` : ""}`;
      } else if (row.action === "UPDATE") {
        title = "تم تعديل فاتورة";
        body = after && before ? `${num} · ${money(before.amount)} ← ${money(after.amount)}` : num;
      } else {
        title = "فاتورة جديدة";
        body = after ? `${num} · ${money(after.amount)}` : num;
      }
      break;
    }
    case "target": {
      const label =
        row.entity === "WarrantyTarget" ? "هدف BOXI" :
        row.entity === "AgencyTarget" ? "هدف الوكالة" :
        "تم تحديث الهدف";
      if (row.action === "DELETE") {
        title = `تم حذف ${label}`;
        body = `${d.year ?? ""}-${String(d.month ?? "").padStart(2, "0")}`;
      } else {
        title = row.action === "CREATE" ? `تم ضبط ${label}` : `تم تحديث ${label}`;
        const period = d.year && d.month ? ` · ${d.year}-${String(d.month).padStart(2, "0")}` : "";
        if (d.total != null) body = `الإجمالي ${money(d.total)}${period}`;
        else if (d.amount != null) {
          const manual = d.manualCount ? ` · ${d.manualCount} يدوي` : " · توزيع متساوٍ";
          body = `${money(d.amount)}${period}${manual}`;
        } else body = period.trim();
      }
      break;
    }
    case "stuff": {
      if (row.action === "DELETE") {
        title = "تم حذف Stuff";
        body = d.name || "";
      } else {
        title = "تمت إضافة Stuff";
        body = [d.name, d.departmentCode].filter(Boolean).join(" · ");
      }
      break;
    }
    case "employee": {
      if (row.action === "DELETE") {
        title = "تم حذف مروج";
        body = d.name || "";
      } else {
        title = "تمت إضافة مروج";
        body = [d.name, d.company, d.departmentCode].filter(Boolean).join(" · ");
      }
      break;
    }
    case "month": {
      const closed = row.action === "CLOSE_MONTH";
      title = closed ? "تم إغلاق الشهر" : "تم إعادة فتح الشهر";
      body = `${d.year ?? ""}-${String(d.month ?? "").padStart(2, "0")}`;
      break;
    }
    default: {
      title = row.action === "DELETE" ? "تم حذف عنصر" : "تم تحديث البيانات";
      body = row.entity;
    }
  }

  return {
    id: row.id,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    title,
    body,
    kind,
    level,
    at: row.createdAt.toISOString(),
    details: (row.details as Record<string, unknown>) ?? null,
    before: (row.before as Record<string, unknown>) ?? null,
    after: (row.after as Record<string, unknown>) ?? null,
  };
}

/**
 * Records one change so the notification feed can pick it up.
 *
 * This is the single entry point every mutating route should use: writing the
 * `AuditLog` row is what makes the change visible to `/api/changes`, which in
 * turn raises the device notification. It never throws — a failure to log must
 * not break the operation the user actually asked for.
 *
 * @param action  what happened (CREATE / UPDATE / DELETE / CLOSE_MONTH …)
 * @param entity  the model name, e.g. "Invoice", "MonthlyTarget", "Month"
 * @param entityId the row id, when there is one
 * @param details arbitrary JSON shown in the notification body
 */
export async function recordChange(
  action: AuditAction,
  entity: string,
  entityId?: string | null,
  details?: Record<string, unknown>,
) {
  try {
    await prisma.auditLog.create({
      // Prisma types Json as a narrower input shape, so the plain object is cast.
      data: { action, entity, entityId: entityId ?? null, details: (details ?? {}) as Prisma.InputJsonValue },
    });
  } catch (e) {
    console.error(`CHANGE_LOG_ERROR ${entity}.${action}`, e);
  }
}