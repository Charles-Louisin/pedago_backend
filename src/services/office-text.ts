import zlib from "node:zlib";

/**
 * Lecture du texte des fichiers Word (.docx) et Excel (.xlsx), sans dépendance : ce sont des archives ZIP
 * de XML. Les TABLEAUX sont rendus ligne par ligne (« | cellule | cellule | »), cellules fusionnées
 * recopiées dans chaque colonne couverte : la grille d'un emploi du temps reste alignée.
 *
 * Garde-fous : ZIP64 refusé, taille décompressée plafonnée (bombe ZIP), seules les entrées utiles lues.
 */
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 200_000;

export class OfficeReadError extends Error {}

type Entry = { name: string; method: number; compSize: number; size: number; localOffset: number };

function entries(buf: Buffer): Entry[] {
  // Fin du répertoire central : dans les 64 Ko (+ 22 octets) de fin de fichier.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new OfficeReadError("Archive illisible");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new OfficeReadError("Archive trop grande");
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new OfficeReadError("Archive abîmée");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(buf: Buffer, e: Entry): Buffer {
  if (e.size > MAX_ENTRY_BYTES) throw new OfficeReadError("Fichier trop volumineux une fois décompressé");
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new OfficeReadError("Archive abîmée");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new OfficeReadError("Compression non prise en charge");
}

export function zipEntryNames(buf: Buffer): string[] {
  try {
    return entries(buf).map((e) => e.name);
  } catch {
    return [];
  }
}

function zipFiles(buf: Buffer, wanted: (name: string) => boolean) {
  const map = new Map<string, string>();
  for (const e of entries(buf)) if (wanted(e.name)) map.set(e.name, read(buf, e).toString("utf8"));
  return map;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? "";
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
  });
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const row = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "/")).join(" | ")} |`;

/* ───────── Word ───────── */

function paragraphText(xml: string) {
  // <w:t> = texte ; tabulation et retour à la ligne gardent la séparation des mots.
  const withBreaks = xml.replace(/<w:tab\/>/g, " ").replace(/<w:br[^>]*\/>/g, " / ");
  let out = "";
  for (const m of withBreaks.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|( \/ )/g)) out += m[1] !== undefined ? decodeXml(m[1]) : m[2];
  return clean(out);
}

function cellText(xml: string) {
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => paragraphText(m[0])).filter(Boolean).join(" / ");
}

function tableRows(tbl: string): string[] {
  const lines: string[] = [];
  let above: string[] = [];
  for (const tr of tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const tc of tr[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)) {
      const props = tc[0].match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] ?? "";
      const span = Number(props.match(/<w:gridSpan w:val="(\d+)"/)?.[1] ?? 1);
      // Fusion verticale : la cellule « continue » reprend le texte de celle du dessus.
      const vContinue = /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(props);
      const col = cells.length;
      const text = vContinue ? above[col] ?? "" : cellText(tc[0]);
      for (let k = 0; k < Math.max(1, Math.min(span, 20)); k++) cells.push(text);
    }
    above = cells;
    if (cells.some(Boolean)) lines.push(row(cells));
  }
  return lines;
}

export function docxText(buf: Buffer): string {
  const files = zipFiles(buf, (n) => n === "word/document.xml");
  const xml = files.get("word/document.xml");
  if (!xml) throw new OfficeReadError("Document Word illisible");
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const lines: string[] = [];
  // Tableaux et paragraphes dans l'ordre du document (tableaux imbriqués : rares, lus à plat).
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      lines.push("", ...tableRows(m[0]), "");
    } else {
      const t = paragraphText(m[0]);
      if (t) lines.push(t);
    }
    if (lines.join("\n").length > MAX_TEXT) break;
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
}

/* ───────── Excel ───────── */

function colIndex(ref: string) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Nombre entre 0 et 1 tombant sur une minute entière : une heure Excel (0,3125 → 07:30). */
function excelValue(v: string) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return v;
  const minutes = n * 1440;
  if (Math.abs(minutes - Math.round(minutes)) > 0.01) return v;
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function xlsxText(buf: Buffer): string {
  const files = zipFiles(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(files.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    clean([...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""))
  );
  const names = [...(files.get("xl/workbook.xml") ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const sheets = [...files.keys()].filter((k) => k.startsWith("xl/worksheets/")).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  sheets.forEach((key, i) => {
    const xml = files.get(key)!;
    const grid = new Map<number, string[]>();
    for (const r of xml.matchAll(/<row ([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = Number(r[1].match(/r="(\d+)"/)?.[1] ?? grid.size + 1);
      const cells: string[] = [];
      for (const c of (r[2] ?? "").matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1] ?? "A";
        const t = attrs.match(/t="(\w+)"/)?.[1];
        const inner = c[2] ?? "";
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
        let text = "";
        if (t === "s" && v !== undefined) text = shared[Number(v)] ?? "";
        else if (t === "inlineStr") text = clean([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join(""));
        else if (v !== undefined) text = t === "str" || t === "b" ? decodeXml(v) : excelValue(v);
        cells[colIndex(ref)] = text;
      }
      grid.set(rowNum, cells);
    }
    // Cellules fusionnées (« RÉCRÉATION » sur toute la ligne) : recopiées sur la zone couverte.
    for (const m of xml.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)) {
      const [c1, r1, c2, r2] = [colIndex(m[1]), Number(m[2]), colIndex(m[3]), Number(m[4])];
      const value = grid.get(r1)?.[c1] ?? "";
      if (!value || (r2 - r1 + 1) * (c2 - c1 + 1) > 400) continue;
      for (let rr = r1; rr <= r2; rr++) {
        const cells = grid.get(rr) ?? [];
        for (let cc = c1; cc <= c2; cc++) if (!cells[cc]) cells[cc] = value;
        grid.set(rr, cells);
      }
    }
    out.push(`Feuille ${names[i] ?? i + 1}`);
    for (const n of [...grid.keys()].sort((a, b) => a - b)) {
      const cells = Array.from(grid.get(n)!, (c) => c ?? "");
      if (cells.some(Boolean)) out.push(row(cells));
    }
    out.push("");
  });
  return out.join("\n").trim().slice(0, MAX_TEXT);
}
