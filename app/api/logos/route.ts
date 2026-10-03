import { NextResponse } from "next/server";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const LOGO_DIR = join(process.cwd(), "public", "logos");
const EXT = /\.(png|webp|avif|jpg|jpeg|svg)$/i;

/**
 * Lists the brand logos available for the promoter form.
 *
 * The picker is built from the folder rather than a hardcoded list, so dropping a new
 * logo into public/logos makes it selectable without touching any code.
 */
export async function GET() {
  try {
    const files = readdirSync(LOGO_DIR)
      .filter((f) => EXT.test(f))
      .sort()
      .map((f) => ({
        file: f,
        // `BrandMark` renders /logos/<file>, and the label is the stem with dashes
        // turned back into spaces so the grid is readable.
        label: f.replace(EXT, "").replace(/-/g, " "),
      }));
    return NextResponse.json(files);
  } catch {
    // A missing folder must not break the promoter form; the picker just stays empty.
    return NextResponse.json([]);
  }
}