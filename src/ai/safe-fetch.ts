import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { env } from "../config/env.js";

const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
/** Stockage de fichiers PEDAGO (sources PDF envoyées par l'équipe). */
const UPLOADTHING_HOSTS = ["utfs.io", "ufs.sh"];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("ff");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

const matches = (host: string, domains: string[]) => {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
};

export function isAllowedHost(host: string) {
  return matches(host, env.sourceDomainAllowlist);
}

export function isUploadThingUrl(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && matches(u.hostname, UPLOADTHING_HOSTS);
  } catch {
    return false;
  }
}

/**
 * Résolution DNS « épinglée » : l'adresse vérifiée est exactement celle utilisée pour la connexion
 * (protège contre le DNS rebinding, où le nom change d'adresse entre la vérification et la requête).
 */
const pinnedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) {
      return (callback as any)(new Error("Adresse réseau interne refusée"));
    }
    if ((options as dns.LookupOptions).all) return (callback as any)(null, list);
    (callback as any)(null, list[0].address, list[0].family);
  });
};

function get(url: URL): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.get(url, { lookup: pinnedLookup, headers: { "User-Agent": "PEDAGO-SourceBot/1.0" }, timeout: TIMEOUT_MS }, resolve);
    req.on("timeout", () => req.destroy(new Error("Délai dépassé")));
    req.on("error", reject);
  });
}

/**
 * Téléchargement d'une source documentaire avec protection SSRF :
 * domaine officiel en liste blanche (ou stockage PEDAGO), IP publique épinglée, redirections revérifiées, taille bornée.
 */
export async function safeFetch(rawUrl: string, redirects = 0): Promise<{ url: string; mime: string; data: Buffer; sha256: string }> {
  if (redirects > 3) throw new Error("Trop de redirections");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Protocole refusé");
  if (url.username || url.password) throw new Error("URL avec identifiants refusée");
  if (!isAllowedHost(url.hostname) && !isUploadThingUrl(rawUrl)) throw new Error(`Domaine hors liste blanche : ${url.hostname}`);
  if (net.isIP(url.hostname)) throw new Error("Adresse IP directe refusée");

  const res = await get(url);
  const status = res.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    res.resume();
    const loc = res.headers.location;
    if (!loc) throw new Error("Redirection sans destination");
    return safeFetch(new URL(loc, url).toString(), redirects + 1);
  }
  if (status < 200 || status >= 300) {
    res.resume();
    throw new Error(`Téléchargement impossible (${status})`);
  }
  if (Number(res.headers["content-length"] || 0) > MAX_BYTES) {
    res.destroy();
    throw new Error("Fichier trop volumineux");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res) {
    size += (chunk as Buffer).length;
    if (size > MAX_BYTES) {
      res.destroy();
      throw new Error("Fichier trop volumineux");
    }
    chunks.push(chunk as Buffer);
  }
  const data = Buffer.concat(chunks);
  const mime = String(res.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
  return { url: url.toString(), mime, data, sha256: crypto.createHash("sha256").update(data).digest("hex") };
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
