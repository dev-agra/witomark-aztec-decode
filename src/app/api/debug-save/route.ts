// TEMPORARY investigation endpoint — not part of the product. Delete after use.
import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(req: NextRequest) {
  const { name, dataUrl, json } = await req.json();
  const dir = path.join(process.cwd(), "debug-out");
  await mkdir(dir, { recursive: true });
  if (json !== undefined) {
    await writeFile(path.join(dir, name), JSON.stringify(json, null, 2));
  } else {
    const base64 = dataUrl.split(",")[1];
    const buf = Buffer.from(base64, "base64");
    await writeFile(path.join(dir, name), buf);
  }
  return NextResponse.json({ ok: true });
}
