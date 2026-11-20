import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { env } from "../config/env.js";

const MAX_BYTES = 25 * 1024 * 1024;

function isPrivateIp(ip: string) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

export function isAllowedHost(host: string) {
  const h = host.toLowerCase();
  return env.sourceDomainAllowlist.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Téléchargement d'une source documentaire avec protection SSRF :
 * HTTPS (ou HTTP pour certains sites officiels), domaine en liste blanche, IP publique, redirections revérifiées, taille bornée.
 */
export async function safeFetch(rawUrl: string, redirects = 0): Promise<{ url: string; mime: string; data: Buffer; sha256: string }> {
  if (redirects > 3) throw new Error("Trop de redirections");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Protocole refusé");
  if (url.username || url.password) throw new Error("URL avec identifiants refusée");
  if (!isAllowedHost(url.hostname)) throw new Error(`Domaine hors liste blanche : ${url.hostname}`);
  const addrs = await dns.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Adresse réseau interne refusée");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "PEDAGO-SourceBot/1.0" } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("Redirection sans destination");
      return safeFetch(new URL(loc, url).toString(), redirects + 1);
    }
    if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_BYTES) throw new Error("Fichier trop volumineux");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error("Fichier trop volumineux");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const mime = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
    return { url: url.toString(), mime, data, sha256: crypto.createHash("sha256").update(data).digest("hex") };
  } finally {
    clearTimeout(timer);
  }
}

/** Texte brut d'une page HTML (scripts et styles retirés). */
export function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
