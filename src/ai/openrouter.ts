import { env } from "../config/env.js";
import { AiJob, AiUsageLog } from "../models/index.js";

export class BudgetExceededError extends Error {}
export class AiNotConfiguredError extends Error {}

type Part =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } }
  | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | Part[] };

type ChatInput = {
  jobId: string;
  step: string;
  model: string;
  promptVersion: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  /** Greffons OpenRouter (ex. recherche web : [{ id: "web", max_results: 8 }]). */
  plugins?: { id: string; [k: string]: unknown }[];
};

/**
 * Appel OpenRouter côté serveur uniquement. Chaque appel :
 * - vérifie le budget restant de la tâche AVANT d'envoyer la requête,
 * - enregistre modèle, fournisseur, tokens (dont tokens en cache), coût réel, latence et version du prompt.
 */
export async function chat(input: ChatInput) {
  if (!env.openrouterApiKey) throw new AiNotConfiguredError("OPENROUTER_API_KEY manquant");
  const job = await AiJob.findById(input.jobId).select("budgetUsd spentUsd").lean();
  if (!job) throw new Error("Tâche IA introuvable");
  if (job.spentUsd >= job.budgetUsd) throw new BudgetExceededError(`Budget atteint (${job.spentUsd.toFixed(3)} $)`);
  const since = new Date(Date.now() - 86_400_000);
  const [day] = await AiUsageLog.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: null, cost: { $sum: "$costUsd" } } }]);
  if ((day?.cost ?? 0) >= env.aiDailyBudgetUsd) {
    throw new BudgetExceededError(`Plafond quotidien atteint (${env.aiDailyBudgetUsd} $ sur 24 h)`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.aiRequestTimeoutMs);
  const started = Date.now();
  let log: Record<string, unknown> = { jobId: input.jobId, step: input.step, model: input.model, promptVersion: input.promptVersion };
  try {
    const res = await fetch(`${env.openrouterBaseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.openrouterApiKey}`,
        "Content-Type": "application/json",
        "X-Title": "PEDAGO",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens ?? 6000,
        temperature: input.temperature ?? 0.3,
        ...(input.json ? { response_format: { type: "json_object" } } : {}),
        ...(input.plugins ? { plugins: input.plugins } : {}),
        usage: { include: true },
        provider: { data_collection: "deny", allow_fallbacks: true },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? "erreur"}`);
    const usage = body.usage ?? {};
    const cost = Number(usage.cost ?? 0);
    log = {
      ...log,
      provider: body.provider,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      costUsd: cost,
      ok: true,
    };
    await AiJob.updateOne(
      { _id: input.jobId },
      { $inc: { spentUsd: cost, tokensIn: usage.prompt_tokens ?? 0, tokensOut: usage.completion_tokens ?? 0 } }
    );
    const text: string = body.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("Réponse vide du modèle");
    return { text, cost };
  } catch (err) {
    log = { ...log, ok: false, error: (err as Error).message.slice(0, 500) };
    throw err;
  } finally {
    clearTimeout(timer);
    await AiUsageLog.create({ ...log, latencyMs: Date.now() - started }).catch(() => undefined);
  }
}

/** Extrait le premier objet JSON d'une réponse (tolère un bloc ```json). */
export function parseJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Aucun JSON dans la réponse");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}
