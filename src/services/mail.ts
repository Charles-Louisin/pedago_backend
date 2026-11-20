import { env, isProduction } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Envoi d'e-mails transactionnels via l'API Resend (sans dépendance supplémentaire).
 * Sans clé en développement, le contenu est seulement journalisé.
 */
export async function sendMail(to: string, subject: string, html: string, text: string) {
  if (!env.resendApiKey) {
    if (isProduction) throw new Error("RESEND_API_KEY manquant : impossible d'envoyer l'e-mail");
    logger.info({ to, subject }, "E-mail (développement, non envoyé)");
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.mailFrom, to, subject, html, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Envoi d'e-mail impossible (${res.status})`);
}

export function verificationEmail(name: string, code: string) {
  const first = name.split(" ")[0];
  const text = `Bonjour ${first},\n\nVoici ton code de vérification PEDAGO : ${code}\nIl est valable 15 minutes.\n\nSi tu n'as pas créé de compte, ignore ce message.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:460px;margin:auto;padding:24px;color:#111214">
<p style="font-size:15px">Bonjour ${first.replace(/[<>&"]/g, "")},</p>
<p style="font-size:15px">Voici ton code de vérification PEDAGO :</p>
<p style="font-size:34px;font-weight:700;letter-spacing:8px;color:#0b8a55;margin:18px 0">${code}</p>
<p style="font-size:13px;color:#6b6f76">Ce code est valable 15 minutes. Si tu n'as pas créé de compte, ignore ce message.</p>
</div>`;
  return { subject: `${code} est ton code PEDAGO`, html, text };
}
