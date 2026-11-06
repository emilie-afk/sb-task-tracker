// KPI scorecard spreadsheet import (EOS scorecard layout: metric in column A, sub-metric in column B, first
// numeric value from column C onward as the target; the first three rows are headers). Replaces the old
// browser-side parser loaded from a CDN with the pinned, maintained ExcelJS package, run on the server.
//
// The file is untrusted. Before parsing, the ZIP container is inspected without decompressing: entry count and
// total uncompressed size are capped (zip-bomb guard). After parsing, rows, columns, cells and text are capped.
import ExcelJS from "exceljs";
import { HttpError } from "./http";

export const XLSX_LIMITS = { bytes: 1024 * 1024, zipEntries: 300, uncompressedBytes: 20 * 1024 * 1024, rows: 500, columns: 30, cells: 10_000, text: 160 };

/** Reads the ZIP central directory (no decompression) and enforces entry and size limits. */
export function inspectZip(buf: Buffer) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new HttpError(400, "invalid_file", "This is not an .xlsx file.");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new HttpError(400, "invalid_file", "The file is damaged.");
  const entries = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new HttpError(400, "invalid_file", "ZIP64 files are not accepted.");
  if (entries > XLSX_LIMITS.zipEntries) throw new HttpError(413, "too_large", "The file has too many parts.");
  if (cdOffset + cdSize > buf.length) throw new HttpError(400, "invalid_file", "The file is damaged.");
  let p = cdOffset, total = 0;
  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(400, "invalid_file", "The file is damaged.");
    const compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff || compressed === 0xffffffff) throw new HttpError(400, "invalid_file", "ZIP64 files are not accepted.");
    if (compressed > 0 && size / compressed > 200) throw new HttpError(413, "too_large", "The file expands too much.");
    total += size;
    if (total > XLSX_LIMITS.uncompressedBytes) throw new HttpError(413, "too_large", "The file expands too much.");
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as any;
    if (Array.isArray(o.richText)) return o.richText.map((x: any) => String(x?.text ?? "")).join("");
    if ("result" in o) return cellText(o.result);
    if ("text" in o) return String(o.text ?? "");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return "";
  }
  return String(v);
};
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();

export type KpiRow = { row: number; metric: string; sub_metric: string | null; target: string | null };

export async function parseKpiWorkbook(buf: Buffer): Promise<{ rows: KpiRow[]; skipped: { row: number; reason: string }[] }> {
  if (buf.length > XLSX_LIMITS.bytes) throw new HttpError(413, "too_large", "The file is larger than 1 MB.");
  inspectZip(buf);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw new HttpError(400, "invalid_file", "The spreadsheet could not be read. Save it as .xlsx and try again."); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, "invalid_file", "The spreadsheet has no sheets.");
  if (ws.rowCount > XLSX_LIMITS.rows) throw new HttpError(413, "too_large", `The first sheet has more than ${XLSX_LIMITS.rows} rows.`);
  if (ws.columnCount > XLSX_LIMITS.columns) throw new HttpError(413, "too_large", `The first sheet has more than ${XLSX_LIMITS.columns} columns.`);
  const rows: KpiRow[] = [], skipped: { row: number; reason: string }[] = [];
  let cells = 0, lastMetric = "";
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const values: string[] = [];
    for (let c = 1; c <= Math.min(ws.columnCount, XLSX_LIMITS.columns); c++) {
      if (++cells > XLSX_LIMITS.cells) throw new HttpError(413, "too_large", "The sheet has too many cells.");
      values.push(clean(cellText(row.getCell(c).value)));
    }
    if (r <= 3) continue;                                      // header rows
    const [a = "", b = ""] = values;
    if (!a && !b) continue;
    if (a.length > XLSX_LIMITS.text || b.length > XLSX_LIMITS.text) { skipped.push({ row: r, reason: "text longer than 160 characters" }); continue; }
    if (a) lastMetric = a;
    if (!b || b.toLowerCase() === "metrics") continue;
    const num = values.slice(2).find((v) => v !== "" && Number.isFinite(Number(v)) && v.length <= 40);
    rows.push({ row: r, metric: lastMetric || b, sub_metric: a && b ? b : lastMetric ? b : null, target: num ?? null });
  }
  return { rows, skipped };
}
