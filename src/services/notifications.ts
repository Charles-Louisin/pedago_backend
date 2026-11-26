import { Types } from "mongoose";
import { env } from "../config/env.js";
import { LessonInstance, Notification, PushToken, TeacherProfile } from "../models/index.js";
import { CurriculumNode } from "../models/index.js";
import { addDays } from "../utils/dates.js";
import { logger } from "../utils/logger.js";

export type NotifyInput = { key: string; kind: "lesson" | "bilan" | "file" | "import" | "info"; title: string; body: string; href?: string };

/**
 * Crée la notification (une seule fois par clé) et l'envoie en push sur les téléphones de l'utilisateur
 * (service push d'Expo). Sans téléphone enregistré, elle reste visible dans la cloche de l'app.
 */
export async function notify(userId: string | Types.ObjectId, n: NotifyInput) {
  const res = await Notification.updateOne({ userId, key: n.key }, { $setOnInsert: { ...n, userId } }, { upsert: true });
  if (!res.upsertedCount) return false;
  const profile = await TeacherProfile.findOne({ userId }).select("preferences").lean();
  if ((profile?.preferences as { pushReminders?: boolean } | undefined)?.pushReminders === false) return true;
  const tokens = await PushToken.find({ userId }).select("token").lean();
  if (!tokens.length) return true;
  try {
    const out = await sendPush(tokens.map((t) => t.token), n);
    await Notification.updateOne({ userId, key: n.key }, { pushedAt: new Date(), ...(out.error ? { pushError: out.error } : {}) });
  } catch (err) {
    await Notification.updateOne({ userId, key: n.key }, { pushError: (err as Error).message.slice(0, 300) });
  }
  return true;
}

/** Envoi par le service push d'Expo ; les jetons refusés (application désinstallée) sont oubliés. */
async function sendPush(tokens: string[], n: NotifyInput) {
  const messages = tokens.map((to) => ({ to, title: n.title, body: n.body, sound: "default", channelId: "rappels", priority: "high", data: { href: n.href ?? "/" } }));
  const res = await fetch(env.expoPushUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(env.expoPushToken ? { Authorization: `Bearer ${env.expoPushToken}` } : {}) },
    body: JSON.stringify(messages),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { status: string; details?: { error?: string } }[] };
  if (!res.ok) return { error: `Expo push ${res.status}` };
  const gone = (body.data ?? []).map((d, i) => (d.status === "error" && d.details?.error === "DeviceNotRegistered" ? tokens[i] : null)).filter(Boolean);
  if (gone.length) await PushToken.deleteMany({ token: { $in: gone } });
  const errors = (body.data ?? []).filter((d) => d.status === "error").length;
  return { error: errors ? `${errors} envoi(s) refusé(s)` : null };
}

/** Date et minute locales (fuseau des écoles, Cameroun par défaut). */
export function localNow(now = new Date(), timeZone = env.schoolTimeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const toMin = (hhmm?: string | null) => (hhmm ? Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) : 0);

/**
 * Rappels de la journée, vérifiés chaque minute pour les comptes qui ont un téléphone enregistré :
 * 10 min avant chaque cours, le bilan 15 min après le dernier cours, et à 18 h les fiches du lendemain.
 */
export async function runReminders(now = new Date()) {
  const { date, minutes } = localNow(now);
  const users = await PushToken.distinct("userId");
  if (!users.length) return 0;
  const tomorrow = addDays(date, 1);
  const lessons = await LessonInstance.find({ teacherId: { $in: users }, date: { $in: [date, tomorrow] }, status: { $in: ["planned", "done", "partial", "missed"] } })
    .select("teacherId nodeId date start end status")
    .lean();
  const titles = new Map((await CurriculumNode.find({ _id: { $in: [...new Set(lessons.map((l) => String(l.nodeId)))] } }).select("title").lean()).map((n) => [String(n._id), n.title]));
  let sent = 0;
  const byUser = new Map<string, typeof lessons>();
  for (const l of lessons) byUser.set(String(l.teacherId), [...(byUser.get(String(l.teacherId)) ?? []), l]);
  for (const [userId, list] of byUser) {
    const today = list.filter((l) => l.date === date).sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    for (const l of today) {
      const start = toMin(l.start);
      if (l.status === "planned" && minutes >= start - 10 && minutes < start) {
        const title = titles.get(String(l.nodeId)) ?? "Cours";
        if (await notify(userId, { key: `lesson:${l._id}`, kind: "lesson", title: `Dans ${start - minutes} min : ${title}`, body: `${l.start} – ${l.end} · touche pour ouvrir la fiche`, href: `/generer?lessonId=${l._id}&date=${l.date}` })) sent++;
      }
    }
    const last = today[today.length - 1];
    const open = today.filter((l) => l.status === "planned").length;
    if (last?.end && open && minutes >= toMin(last.end) + 15) {
      if (await notify(userId, { key: `bilan:${date}`, kind: "bilan", title: "Bilan de la journée", body: `${open} cours à renseigner : fait, pas fait ou à reporter.`, href: `/bilan?date=${date}` })) sent++;
    }
    const next = list.filter((l) => l.date === tomorrow && l.status === "planned").length;
    if (next && minutes >= 18 * 60) {
      if (await notify(userId, { key: `files:${tomorrow}`, kind: "file", title: "Tes fiches de demain sont prêtes", body: `${next} cours demain : télécharge les fiches pour les lire sans connexion.`, href: "/fiches" })) sent++;
    }
  }
  return sent;
}

/** Boucle des rappels (une vérification par minute), dans le processus de l'API. */
export function startReminders() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await runReminders();
    } catch (err) {
      logger.warn({ err }, "Rappels : vérification impossible");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
