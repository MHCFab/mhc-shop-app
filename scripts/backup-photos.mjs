/**
 * backup-photos.mjs — pull every product photo out of Supabase Storage and
 * keep a copy you control.
 *
 * WHY THIS EXISTS
 * Supabase's daily database backups deliberately do NOT include stored files.
 * The 31 Aug restore test proved it exactly: the photo ROWS came back, the
 * image FILES did not. So a restore hands you a product with a broken picture.
 * This script is the missing half of that backup.
 *
 * HOW TO RUN (from the repo root, in the Cursor terminal):
 *
 *     node scripts/backup-photos.mjs
 *
 * or to put the copy somewhere else — an external drive, a synced folder:
 *
 *     node scripts/backup-photos.mjs "D:\\Backups\\shopworks-photos"
 *
 * It reads .env.local itself. Nothing is typed, pasted, or printed: the service
 * key never leaves your machine and is never echoed to the terminal.
 *
 * Safe to re-run as often as you like. Files already saved with a matching size
 * are skipped, so a repeat run only fetches what is new.
 */

import { createClient } from "@supabase/supabase-js";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const BUCKET = "product-photos";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
// Defaults to a folder BESIDE the repo, not inside it - a backup has no
// business living in a git working tree where it could be committed.
const OUT_DIR = path.resolve(
  process.argv[2] || path.join(REPO_ROOT, "..", "shopworks-photo-backups")
);

/* ---------- credentials, read straight from .env.local ---------- */

async function readEnv() {
  const envPath = path.join(REPO_ROOT, ".env.local");
  if (!existsSync(envPath)) {
    fail(
      "Couldn't find .env.local in " + REPO_ROOT + ".\n" +
      "Run this from the repo, on the machine where you develop."
    );
  }
  const text = await readFile(envPath, "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is missing from .env.local.");
  if (!key) {
    fail(
      "SUPABASE_SERVICE_ROLE_KEY is missing from .env.local.\n" +
      "It's in the Supabase dashboard under Project Settings -> API.\n" +
      "Photos are in a private bucket, so reading them needs that key."
    );
  }
  return { url, key };
}

function fail(msg) {
  console.error("\n  " + msg.split("\n").join("\n  ") + "\n");
  process.exit(1);
}

/* ---------- walk the bucket ---------- */

async function listAll(supabase, prefix = "") {
  const out = [];
  const pageSize = 100;
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: pageSize, offset, sortBy: { column: "name", order: "asc" } });

    if (error) fail("Couldn't list " + (prefix || "the bucket root") + ": " + error.message);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const full = prefix ? prefix + "/" + entry.name : entry.name;
      // Storage returns folders as entries with no id.
      if (entry.id === null || entry.id === undefined) {
        out.push(...(await listAll(supabase, full)));
      } else {
        out.push({ path: full, size: entry.metadata?.size ?? null, updated: entry.updated_at ?? null });
      }
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

/* ---------- main ---------- */

const { url, key } = await readEnv();
const supabase = createClient(url, key, { auth: { persistSession: false } });

console.log("\n  Backing up " + BUCKET + " to:\n  " + OUT_DIR + "\n");

const files = await listAll(supabase);
if (files.length === 0) {
  console.log("  The bucket is empty. Nothing to back up.\n");
  process.exit(0);
}

let saved = 0, skipped = 0;
const failures = [];

for (const f of files) {
  const dest = path.join(OUT_DIR, ...f.path.split("/"));

  if (existsSync(dest) && f.size !== null) {
    const local = await stat(dest);
    if (local.size === f.size) {
      skipped += 1;
      continue;
    }
  }

  const { data, error } = await supabase.storage.from(BUCKET).download(f.path);
  if (error || !data) {
    failures.push({ path: f.path, message: error?.message || "no data returned" });
    console.log("  FAILED   " + f.path + "  (" + (error?.message || "no data") + ")");
    continue;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await data.arrayBuffer()));
  saved += 1;
  console.log("  saved    " + f.path);
}

/* ---------- pair the files with the rows that point at them ---------- */

const { data: rows, error: rowErr } = await supabase
  .from("product_template_photos")
  .select("id, product_template_id, storage_path, sort_order, created_at");

if (rowErr) {
  console.log("\n  Note: couldn't read product_template_photos (" + rowErr.message + ").");
  console.log("  The image files are saved; the manifest just won't name their products.");
}

let templates = [];
if (rows && rows.length) {
  const ids = Array.from(new Set(rows.map((r) => r.product_template_id).filter(Boolean)));
  if (ids.length) {
    const { data: t } = await supabase
      .from("product_templates")
      .select("id, name, product_number")
      .in("id", ids);
    templates = t || [];
  }
}
const nameFor = (id) => {
  const t = templates.find((x) => x.id === id);
  return t ? [t.product_number, t.name].filter(Boolean).join(" ") : null;
};

const storagePaths = new Set(files.map((f) => f.path));
const rowPaths = new Set((rows || []).map((r) => r.storage_path));

// A row whose file is gone: the picture is already lost, backup or not.
const rowsWithoutFile = (rows || []).filter((r) => !storagePaths.has(r.storage_path));
// A file nothing points at: harmless, but it's dead weight in the bucket.
const filesWithoutRow = files.filter((f) => !rowPaths.has(f.path));

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  path.join(OUT_DIR, "manifest.json"),
  JSON.stringify(
    {
      takenAt: new Date().toISOString(),
      bucket: BUCKET,
      fileCount: files.length,
      totalBytes: files.reduce((a, f) => a + (f.size || 0), 0),
      files: files.map((f) => ({
        ...f,
        product: nameFor((rows || []).find((r) => r.storage_path === f.path)?.product_template_id),
      })),
      photoRows: rows || [],
      rowsWithoutFile,
      filesWithoutRow: filesWithoutRow.map((f) => f.path),
    },
    null,
    2
  ) + "\n"
);

/* ---------- what happened ---------- */

const mb = (b) => (b / 1024 / 1024).toFixed(1);
console.log("\n  " + files.length + " file" + (files.length === 1 ? "" : "s") +
  " in the bucket, " + mb(files.reduce((a, f) => a + (f.size || 0), 0)) + " MB total");
console.log("  " + saved + " saved, " + skipped + " already had a matching copy");
console.log("  manifest.json written alongside them");

if (rowsWithoutFile.length) {
  console.log("\n  " + rowsWithoutFile.length + " photo record" +
    (rowsWithoutFile.length === 1 ? "" : "s") + " point at a file that is NOT in storage.");
  console.log("  Those pictures are already gone — this backup can't bring them back.");
  for (const r of rowsWithoutFile) console.log("    " + r.storage_path);
}
if (filesWithoutRow.length) {
  console.log("\n  " + filesWithoutRow.length + " file" +
    (filesWithoutRow.length === 1 ? "" : "s") + " in storage that no product points at (harmless):");
  for (const f of filesWithoutRow) console.log("    " + f.path);
}
if (failures.length) {
  console.log("\n  " + failures.length + " file(s) FAILED to download. Re-run to retry.\n");
  process.exit(1);
}

console.log("\n  Done. Keep a second copy of that folder somewhere off this machine.\n");
