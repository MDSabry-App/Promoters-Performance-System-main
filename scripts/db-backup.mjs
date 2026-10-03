// Full database snapshot in plain JSON.
//
// Run:  npm run db:backup
//
// Why this exists: the whole dashboard lives in one Neon database with no version
// history. A mistaken delete, a bad `prisma db push` or a lost account wipes the
// invoices for good — which is exactly what happened on 2026-10-01, when four
// invoices were removed and the audit log only held their invoice numbers, so the
// amounts could never be recovered.
//
// The dump is committed to the repository by the daily backup workflow, so there is
// a restore point in Git history for every day. `npm run db:restore` reads it back.

import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

/** Decimal/Datetime objects are not JSON-serialisable, so everything is normalised. */
function plain(rows) {
  return JSON.parse(JSON.stringify(rows, (_k, v) => (v && typeof v.toFixed === "function" ? String(v) : v)));
}

async function main() {
  const [departments, companies, employees, invoices, stuff, monthlyTargets, employeeTargets, warrantyTargets, employeeWarrantyTargets, agencyTargets, employeeAgencyTargets, monthLocks] =
    await Promise.all([
      prisma.department.findMany({ orderBy: { code: "asc" } }),
      prisma.company.findMany({ orderBy: { name: "asc" } }),
      prisma.employee.findMany({ orderBy: { employeeCode: "asc" } }),
      prisma.invoice.findMany({ orderBy: { date: "asc" } }),
      prisma.stuff.findMany({ orderBy: [{ year: "desc" }, { month: "desc" }] }),
      prisma.monthlyTarget.findMany(),
      prisma.employeeTarget.findMany(),
      prisma.warrantyTarget.findMany(),
      prisma.employeeWarrantyTarget.findMany(),
      prisma.agencyTarget.findMany(),
      prisma.employeeAgencyTarget.findMany(),
      prisma.monthLock.findMany(),
    ]);

  // Soft-deleted invoices are included on purpose: they are recoverable rows and a
  // backup that drops them could not bring them back after a restore.
  const deletedInvoices = invoices.filter((i) => i.deletedAt);

  const dump = {
    meta: {
      generatedAt: new Date().toISOString(),
      generator: "scripts/db-backup.mjs",
      counts: {
        departments: departments.length,
        companies: companies.length,
        employees: employees.length,
        invoices: invoices.length,
        deletedInvoices: deletedInvoices.length,
        stuff: stuff.length,
        monthlyTargets: monthlyTargets.length,
      },
    },
    departments: plain(departments),
    companies: plain(companies),
    employees: plain(employees),
    invoices: plain(invoices),
    stuff: plain(stuff),
    monthlyTargets: plain(monthlyTargets),
    employeeTargets: plain(employeeTargets),
    warrantyTargets: plain(warrantyTargets),
    employeeWarrantyTargets: plain(employeeWarrantyTargets),
    agencyTargets: plain(agencyTargets),
    employeeAgencyTargets: plain(employeeAgencyTargets),
    monthLocks: plain(monthLocks),
  };

  const dir = join(process.cwd(), "backups");
  mkdirSync(dir, { recursive: true });
  // One dated file per run: `latest.json` is the copy the restore script reads.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const body = JSON.stringify(dump, null, 2);
  writeFileSync(join(dir, `${stamp}.json`), body, "utf8");
  writeFileSync(join(dir, "latest.json"), body, "utf8");

  console.log(`Backup written to backups/${stamp}.json`);
  console.log(
    `  employees=${employees.length} invoices=${invoices.length} (deleted=${deletedInvoices.length}) stuff=${stuff.length} targets=${monthlyTargets.length}`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("Backup failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });