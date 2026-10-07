/**
 * Local catalog import — the strict file format and its validation. Pure: no I/O, no database.
 *
 * FORMAT (UTF-8, comma-separated, RFC 4180 quoting, optional BOM, exactly this header):
 *
 *   source_id,name_ar,name_en,price,currency,base_unit,price_needs_review
 *
 *   source_id           the merchant's own stable row id — the import identity (see below)
 *   name_ar             required; stored exactly as written (whitespace collapsed, nothing else)
 *   name_en             optional; empty means "no English name" — never invented
 *   price               selling price as a plain decimal ("12", "3.50"); > 0; no "$", no commas
 *   currency            must equal the terminal currency
 *   base_unit           one of BASE_UNITS (src/domain/catalog.ts): piece | box | pack | kg | meter | other
 *   price_needs_review  0 | 1 — 1 marks a placeholder price the merchant must still set
 *
 * ALL OR NOTHING: if any row is rejected the whole file is refused and nothing is written, so a
 * half-imported catalog can never reach the till. The caller gets every rejection with its line.
 *
 * IDENTITY: a row is the same product as an earlier import when its source_id is the same. Names
 * repeat in real catalogs (same name, different size or price), so a name is never an identity.
 * Risk, stated: if the merchant renumbers rows in a later export, a source_id would point at a
 * different product — the re-import would then show it as "updated". Past sales are unaffected
 * either way: every sale line snapshots its own name and price.
 */
import { BASE_UNITS, MAX_PRODUCT_ID_LENGTH } from "./catalog";
import { DomainError } from "./errors";
import { parseDecimal } from "./money";

export const IMPORT_HEADER = ["source_id", "name_ar", "name_en", "price", "currency", "base_unit", "price_needs_review"];
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
/** Longest merchant row id. Product ids are "<source>:<source_id>", which must fit MAX_PRODUCT_ID_LENGTH. */
export const MAX_SOURCE_ID_LENGTH = 64;
const MAX_NAME = 200;

export interface ImportRow {
  readonly sourceId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly baseUnit: string;
  readonly priceNeedsReview: boolean;
}

export interface ImportRejection {
  /** 1-based line number in the file (the header is line 1). */
  readonly line: number;
  readonly reason: string;
}

export interface ValidatedImport {
  readonly rows: ReadonlyArray<ImportRow>;
  readonly rejected: ReadonlyArray<ImportRejection>;
}

/**
 * Decodes UTF-8 strictly. A file saved by Excel as "CSV" in a legacy code page (Arabic Windows-1256)
 * is refused here instead of being imported as mojibake.
 */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new DomainError("IMPORT_REJECTED", `The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new DomainError("IMPORT_REJECTED", "The file is not valid UTF-8 — save it as \"CSV UTF-8\" and try again");
  }
}

/** RFC 4180 parser: quoted fields, "" escapes, embedded commas and newlines, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (c === "\r" && src[i + 1] === "\n") i += 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new DomainError("IMPORT_REJECTED", "The file ends inside a quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** Validates every data row against the format above. Never throws for a bad row — it reports it. */
export function validateImport(text: string, terminalCurrency: string): ValidatedImport {
  const table = parseCsv(text);
  const header = table[0];
  if (!header || header.join(",") !== IMPORT_HEADER.join(",")) {
    throw new DomainError("IMPORT_REJECTED", `The first line must be exactly: ${IMPORT_HEADER.join(",")}`);
  }
  const body = table.slice(1);
  if (body.length > MAX_IMPORT_ROWS) {
    throw new DomainError("IMPORT_REJECTED", `The file has more than ${MAX_IMPORT_ROWS} rows`);
  }

  const rows: ImportRow[] = [];
  const rejected: ImportRejection[] = [];
  const seen = new Map<string, number>();
  body.forEach((cells, index) => {
    const line = index + 2;
    if (cells.length === 1 && cells[0] === "") return; // blank line
    const reject = (reason: string) => rejected.push({ line, reason });
    if (cells.length !== IMPORT_HEADER.length) {
      reject(`expected ${IMPORT_HEADER.length} fields, found ${cells.length}`);
      return;
    }
    const [sourceId, nameAr, nameEn, price, currency, baseUnit, review] = cells as [string, ...string[]];

    if (!/^[A-Za-z0-9._-]+$/.test(sourceId) || sourceId.length > MAX_SOURCE_ID_LENGTH) {
      return reject(`invalid source_id '${sourceId}'`);
    }
    const earlier = seen.get(sourceId);
    if (earlier !== undefined) return reject(`source_id '${sourceId}' already used on line ${earlier}`);
    seen.set(sourceId, line);

    const ar = cleanName(nameAr!);
    if (!ar) return reject("name_ar is empty");
    if (ar.length > MAX_NAME) return reject(`name_ar is longer than ${MAX_NAME} characters`);
    if (/[\u0000-\u001F\u007F]/.test(ar)) return reject("name_ar contains control characters");
    const en = cleanName(nameEn!);
    if (en.length > MAX_NAME) return reject(`name_en is longer than ${MAX_NAME} characters`);
    if (/[\u0000-\u001F\u007F]/.test(en)) return reject("name_en contains control characters");

    if (currency !== terminalCurrency) return reject(`currency '${currency}' is not the terminal currency ${terminalCurrency}`);
    let priceMinor: bigint;
    try {
      priceMinor = parseDecimal(price!, currency).minor;
    } catch (err) {
      return reject(err instanceof DomainError ? `price: ${err.message}` : `price '${price}' is not valid`);
    }
    if (priceMinor <= 0n) return reject("price must be greater than zero (use a placeholder with price_needs_review=1)");

    if (!BASE_UNITS.includes(baseUnit!)) return reject(`base_unit '${baseUnit}' must be one of ${BASE_UNITS.join(", ")}`);
    if (review !== "0" && review !== "1") return reject(`price_needs_review '${review}' must be 0 or 1`);

    rows.push({
      sourceId,
      nameAr: ar,
      nameEn: en === "" ? null : en,
      priceMinor,
      currency,
      baseUnit: baseUnit!,
      priceNeedsReview: review === "1",
    });
  });
  if (rows.length === 0 && rejected.length === 0) throw new DomainError("IMPORT_REJECTED", "The file has no products");
  return { rows, rejected };
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────────

/** One catalog row as written back to the import format. Prices travel as exact decimal text. */
export interface ExportRow {
  readonly sourceId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly price: string;
  readonly currency: string;
  readonly baseUnit: string;
  readonly priceNeedsReview: boolean;
}

function csvField(value: string): string {
  return /[",\r\n]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Writes rows in EXACTLY the import format (same header, same columns), so an exported file can be
 * edited in Excel and imported again: unchanged rows come back "unchanged", edited prices "updated".
 * UTF-8 BOM (Excel then reads Arabic correctly) and CRLF line endings. Never rounds: `price` is
 * already exact decimal text produced from integer minor units.
 */
export function toImportCsv(rows: ReadonlyArray<ExportRow>): string {
  const lines = [IMPORT_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [r.sourceId, r.nameAr, r.nameEn ?? "", r.price, r.currency, r.baseUnit, r.priceNeedsReview ? "1" : "0"]
        .map(csvField)
        .join(","),
    );
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
