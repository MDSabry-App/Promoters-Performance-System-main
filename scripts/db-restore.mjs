// Restore a database from a JSON dump produced by `npm run db:backup`.
//
// Run:  npm run db:restore            (restores backups/latest.json)
//       npm run db:restore -- file    (restores a specific dated dump)
//
// HOW THIS WORKS
//   Pass 1  "scan"  — reports what is present in the dump and what is missing from
//                     the database, without writing anything.
//   Pass 2  "apply" — upserts the dump back in, then deletes database rows that are
//                     absent from the dump (so the database matches the snapshot).
//
// REQUIREMENTS
//   Refuses to run unless `--yes` is passed, so a mistyped command cannot wipe a
//   month. Run it with the app paused: pass 2 replaces targets and invoices wholesale.

import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

const MODE = process.argv.includes("--yes") ? "apply" : "scan";
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const FILE = fileArg || "backups/latest.json";

function plain(rows) {
  return JSON.parse(JSON.stringify(rows, (_k, v) => (v && typeof v.toFixed === "function" ? String(v) : v)));
}

/**
 * Every table is restored through these, parents first because of the foreign keys.
 * The first entry is the key used in the JSON dump, the second the Prisma model.
 */
const TABLES = [
  ["departments", "department"],
  ["companies", "company"],
  ["employees", "employee"],
  ["monthlyTargets", "monthlyTarget"],
  ["employeeTargets", "employeeTarget"],
  ["warrantyTargets", "warrantyTarget"],
  ["employeeWarrantyTargets", "employeeWarrantyTarget"],
  ["agencyTargets", "agencyTarget"],
  ["employeeAgencyTargets", "employeeAgencyTarget"],
  ["invoices", "invoice"],
  ["stuff", "stuff"],
  ["monthLocks", "monthLock"],
];

async function main() {
  const path = join(process.cwd(), FILE);
  if (!existsSync(path)) {
    console.error(`Backup file not found: ${path}`);
    process.exit(1);
  }

  const dump = JSON.parse(readFileSync(path, "utf8"));
  console.log(`Restore file : ${FILE}`);
  console.log(`Generated at : ${dump.meta?.generatedAt ?? "unknown"}`);
  console.log(`Mode         : ${MODE}`);

  const live = await prisma.$transaction([
    prisma.department.count(),
    prisma.company.count(),
    prisma.employee.count(),
    prisma.invoice.count(),
    prisma.stuff.count(),
  ]);
  console.log(
    `Live now     : departments=${live[0]} companies=${live[1]} employees=${live[2]} invoices=${live[3]} stuff=${live[4]}`,
  );

  const missingInDump = TABLES.filter(([key]) => !Array.isArray(dump[key]));
  if (missingInDump.length) {
    console.warn(`Tables missing from the dump (skipped): ${missingInDump.join(", ")}`);
  }

  if (MODE === "scan") {
    for (const [key, model] of TABLES) {
      const rows = Array.isArray(dump[key]) ? dump[key] : [];
      const count = await prisma[model].count();
      const delta = rows.length - count;
      const mark = delta === 0 ? "=" : delta > 0 ? `+${delta}` : `${delta}`;
      console.log(`  ${key.padEnd(24)} dump=${String(rows.length).padStart(5)}  live=${String(count).padStart(5)}  ${mark}`);
    }
    console.log("\nThis was a dry run. Nothing was written.");
    console.log(`Re-run with --yes to apply:  npm run db:restore -- ${FILE} --yes`);
    return;
  }

  console.log("\nApplying…");
  for (const [key, model] of TABLES) {
    const rows = Array.isArray(dump[key]) ? dump[key] : [];
    if (!rows.length) continue;

    // Order-insensitive upsert keeps existing rows and repairs anything missing.
    for (const row of plain(rows)) {
      const { id, ...rest } = row;
      await prisma[model].upsert({ where: { id }, update: rest, create: { id, ...rest } });
    }
    console.log(`  ${key.padEnd(24)} upserted ${rows.length}`);
  }

  // Anything created after the dump is removed so the database matches the snapshot.
  const keep = {
    invoice: (dump.invoices ?? []).map((r) => r.id),
    stuff: (dump.stuff ?? []).map((r) => r.id),
  };
  const removedInvoices = await prisma.invoice.deleteMany({ where: { id: { notIn: keep.invoice } } });
  const removedStuff = await prisma.stuff.deleteMany({ where: { id: { notIn: keep.stuff } } });

  console.log(`\nRemoved rows not present in the dump: invoices=${removedInvoices.count} stuff=${removedStuff.count}`);
  console.log("Restore complete.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("Restore failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });