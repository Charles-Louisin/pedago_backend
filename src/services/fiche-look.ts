import { crc32, deflateSync } from "node:zlib";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import type { PrepStyle } from "./layout.js";

/**
 * « Apparence » d'une fiche PDF importée, relevée sans IA dans le dessin de la page :
 * police du corps (Times, Helvetica, Courier, manuscrite), titre centré ou non, intitulés en gras /
 * majuscules / soulignés, couleur d'encre des intitulés, et images (logo, armoiries, dessins) avec
 * leur place : en-tête ou rubrique, à gauche / au centre / à droite, largeur relative.
 * Les images sont recadrées telles qu'imprimées (pixels d'origine, réduits à 600 px au plus).
 */
export type LookFigure = { png: Buffer; anchor: string | null; position: "left" | "center" | "right"; widthPct: number; aspect: number };
export type FicheLook = { style: PrepStyle; figures: LookFigure[] };

const MAX_PAGES = 3;
const MAX_FIGURES = 6;
const MAX_SIDE = 600;

type Run = { text: string; font: string; bold: boolean; fill: string; pathNear: boolean; page: number; at: number };
type Item = { text: string; x: number; top: number; w: number; size: number; page: number };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function fontKind(name: string, serifFlag?: boolean): PrepStyle["font"] {
  const n = name.toLowerCase();
  if (/script|hand|comic|caveat|kalam|brush|segoe ?print|lucida ?hand|chalk|marker|cursive/.test(n)) return "script";
  if (/courier|mono|consol|menlo/.test(n)) return "mono";
  if (/times|serif(?!.*sans)|georgia|garamond|cambria|book ?antiqua|palatino|century|minion|baskerville/.test(n) && !/sans/.test(n)) return "serif";
  if (serifFlag && !/sans|arial|helvet|calibri|verdana|tahoma|segoe/.test(n)) return "serif";
  return "sans";
}

/** PNG RVBA minimal (zlib natif) : pas de dépendance d'image. */
export function encodePng(w: number, h: number, rgba: Uint8Array | Uint8ClampedArray) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Image pdf.js (niveaux de gris 1 bit, RVB, RVBA) → RVBA réduite à MAX_SIDE au plus. */
function toRgba(img: { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray }) {
  const { width: w, height: h, kind, data } = img;
  if (!data || !w || !h) return null;
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  const out = new Uint8Array(W * H * 4);
  const rowBytes1 = Math.ceil(w / 8);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.floor(y / k));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor(x / k));
      const o = (y * W + x) * 4;
      if (kind === 1) {
        const bit = (data[sy * rowBytes1 + (sx >> 3)] >> (7 - (sx & 7))) & 1;
        const v = bit ? 255 : 0;
        out[o] = out[o + 1] = out[o + 2] = v;
        out[o + 3] = 255;
      } else if (kind === 2) {
        const i = (sy * w + sx) * 3;
        out[o] = data[i];
        out[o + 1] = data[i + 1];
        out[o + 2] = data[i + 2];
        out[o + 3] = 255;
      } else {
        const i = (sy * w + sx) * 4;
        out[o] = data[i];
        out[o + 1] = data[i + 1];
        out[o + 2] = data[i + 2];
        out[o + 3] = data[i + 3];
      }
    }
  }
  return { w: W, h: H, rgba: out };
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

const majority = (xs: boolean[]) => xs.length > 0 && xs.filter(Boolean).length * 2 > xs.length;

/**
 * @param sectionLabels intitulés de rubriques trouvés par la lecture du texte (pour situer les intitulés et les images)
 * @param title titre de la fiche (pour l'alignement)
 */
export async function readFicheLook(buf: Buffer, sectionLabels: string[], title?: string | null): Promise<FicheLook | null> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf), { fontExtraProperties: true });
  } catch {
    return null;
  }
  const { OPS } = await getResolvedPDFJS();
  const labels = sectionLabels.map(norm).filter(Boolean);
  const isHeading = (t: string) => {
    const n = norm(t);
    return n.length > 0 && labels.some((l) => n === l || (n.startsWith(l) && n.length - l.length <= 2));
  };

  const runs: Run[] = [];
  const items: Item[] = [];
  const rawFigures: { page: number; top: number; bottom: number; x: number; w: number; pageW: number; pageH: number; img: Parameters<typeof toRgba>[0] | null }[] = [];
  let pageW0 = 595;

  for (let p = 1; p <= Math.min(pdf.numPages, MAX_PAGES); p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    if (p === 1) pageW0 = vp.width;
    const tc = await page.getTextContent();
    for (const it of tc.items as { str?: string; transform: number[]; width: number }[]) {
      if (!it.str?.trim()) continue;
      const size = Math.hypot(it.transform[2], it.transform[3]);
      items.push({ text: it.str, x: it.transform[4], top: vp.height - it.transform[5] - size, w: it.width, size, page: p });
    }

    const ops = await page.getOperatorList();
    const stack: M[] = [];
    let ctm: M = [1, 0, 0, 1, 0, 0];
    let font = { name: "", bold: false };
    let fill = "#000000";
    let lastLine = -1;
    let prevLineOwner = -1;
    let lastRun: Run | null = null;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const a = ops.argsArray[i] as unknown[];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, a as M);
      else if (fn === OPS.setFillRGBColor) fill = String(a[0]).toLowerCase();
      else if (fn === OPS.setFillGray) {
        const v = Math.round(Number(a[0]) * 255).toString(16).padStart(2, "0");
        fill = `#${v}${v}${v}`;
      } else if (fn === OPS.setFont) {
        const id = String(a[0]);
        const f = (page.commonObjs.has(id) ? page.commonObjs.get(id) : null) as { name?: string; bold?: boolean; black?: boolean; isSerifFont?: boolean } | null;
        const name = f?.name ?? "";
        font = { name: name.replace(/^[A-Z]{6}\+/, "") + (f?.isSerifFont ? "|serif" : ""), bold: Boolean(f?.bold || f?.black || /bold|black|heavy|semibold|demi/i.test(name)) };
      } else if (fn === OPS.constructPath) {
        // Trait horizontal fin (souligné) : rattaché au texte qui le précède ou à celui qui le suit.
        const mm = a[2] as ArrayLike<number> | undefined;
        if (mm && mm.length >= 4 && Math.abs(mm[3] - mm[1]) < 2.5 && mm[2] - mm[0] > 15) {
          lastLine = i;
          if (lastRun && !lastRun.pathNear && lastRun.at > prevLineOwner) {
            lastRun.pathNear = true;
            prevLineOwner = lastRun.at;
          }
        }
      } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        const glyphs = (a[0] as ({ unicode?: string } | number | null)[]) ?? [];
        const text = glyphs.map((g) => (g && typeof g === "object" ? (g.unicode ?? "") : typeof g === "number" && g < -200 ? " " : "")).join("");
        if (!text.trim()) continue;
        const run: Run = { text, font: font.name, bold: font.bold, fill, pathNear: lastLine > (lastRun?.at ?? -1), page: p, at: i };
        runs.push(run);
        lastRun = run;
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const corners = [apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        const x = Math.min(...xs);
        const w = Math.max(...xs) - x;
        const yBottom = Math.min(...ys);
        const h = Math.max(...ys) - yBottom;
        // Ni miette, ni page scannée entière (ce n'est pas un dessin, c'est la fiche elle-même).
        if (w < 14 || h < 14 || (w * h) / (vp.width * vp.height) > 0.4) continue;
        if (rawFigures.length >= MAX_FIGURES) continue;
        // Image décodée par pdf.js : on attend sa résolution (2 s au plus).
        const img: Promise<Parameters<typeof toRgba>[0] | null> =
          fn === OPS.paintInlineImageXObject
            ? Promise.resolve(a[0] as Parameters<typeof toRgba>[0])
            : new Promise((res) => {
                const id = String(a[0]);
                const store = id.startsWith("g_") ? page.commonObjs : page.objs;
                const t = setTimeout(() => res(null), 2000);
                store.get(id, (o: unknown) => {
                  clearTimeout(t);
                  res(o as Parameters<typeof toRgba>[0]);
                });
              });
        rawFigures.push({ page: p, top: vp.height - (yBottom + h), bottom: vp.height - yBottom, x, w, pageW: vp.width, pageH: vp.height, img: await img });
      }
    }
    page.cleanup();
  }
  await pdf.cleanup().catch(() => undefined);
  if (!runs.length) return null;

  // Police du corps : celle qui porte le plus de caractères.
  const byFont = new Map<string, number>();
  for (const r of runs) byFont.set(r.font, (byFont.get(r.font) ?? 0) + r.text.length);
  const bodyFont = [...byFont.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const font = fontKind(bodyFont.split("|")[0], bodyFont.endsWith("|serif"));

  // Titre : centré si son milieu tombe au milieu de la page.
  const titleItem = (title ? items.find((it) => it.page === 1 && norm(it.text) === norm(title)) : undefined) ?? items.filter((it) => it.page === 1 && it.top < 260).sort((a, b) => b.size - a.size)[0];
  const titleAlign: PrepStyle["titleAlign"] = titleItem && Math.abs(titleItem.x + titleItem.w / 2 - pageW0 / 2) < pageW0 * 0.08 && titleItem.x > pageW0 * 0.15 ? "center" : "left";

  const headingRuns = runs.filter((r) => isHeading(r.text));
  const inks = headingRuns.map((r) => r.fill).filter((f) => /^#[0-9a-f]{6}$/.test(f));
  const inkCount = new Map<string, number>();
  for (const c of inks) inkCount.set(c, (inkCount.get(c) ?? 0) + 1);
  const topInk = [...inkCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const dark = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16) < 90;
  const style: PrepStyle = {
    font,
    titleAlign,
    headingUppercase: majority(headingRuns.map((r) => /[A-ZÀ-Ý]/.test(r.text) && r.text === r.text.toUpperCase())),
    headingBold: majority(headingRuns.map((r) => r.bold)),
    headingUnderline: majority(headingRuns.map((r) => r.pathNear)),
    headingColon: majority(headingRuns.map((r) => /:s*$/.test(r.text))),
    ink: topInk && !dark(topInk) ? topInk : null,
  };

  // Images : place relative aux intitulés (au-dessus du premier = en-tête, sinon rubrique qui précède).
  const headingItems = items.filter((it) => isHeading(it.text));
  const figures: LookFigure[] = [];
  for (const f of rawFigures.slice(0, MAX_FIGURES)) {
    const px = f.img ? toRgba(f.img) : null;
    if (!px) continue;
    const before = headingItems.filter((h) => h.page < f.page || (h.page === f.page && h.top <= f.top + 2)).pop();
    const firstHeading = headingItems[0];
    const inHeader = !before || (f.page === 1 && firstHeading && firstHeading.page === 1 && f.bottom <= firstHeading.top + 4);
    const label = inHeader ? null : sectionLabels.find((l) => isHeading(before!.text) && norm(before!.text).startsWith(norm(l))) ?? null;
    const mid = (f.x + f.w / 2) / f.pageW;
    figures.push({
      png: encodePng(px.w, px.h, px.rgba),
      anchor: label,
      position: mid < 0.38 ? "left" : mid > 0.62 ? "right" : "center",
      widthPct: Math.round(Math.min(60, Math.max(5, (f.w / f.pageW) * 100)) * 10) / 10,
      aspect: Math.round((f.w / (f.bottom - f.top)) * 1000) / 1000,
    });
  }
  return { style, figures };
}

/** Dimensions d'une photo (JPEG, PNG, WebP) lues dans l'en-tête, sans la décoder. */
export function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.subarray(1, 4).toString("latin1") === "PNG") return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    const fmt = buf.subarray(12, 16).toString("latin1");
    if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
