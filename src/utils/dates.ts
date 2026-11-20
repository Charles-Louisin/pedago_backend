/** Dates locales « YYYY-MM-DD » : calculées sans fuseau (le téléphone fournit la date locale). */
const RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(s: unknown): s is string {
  return typeof s === "string" && RE.test(s);
}

function toUtc(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: string, days: number) {
  const t = new Date(toUtc(date) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** 1 = lundi … 7 = dimanche. */
export function weekday(date: string) {
  const d = new Date(toUtc(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function diffDays(a: string, b: string) {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function* eachDay(from: string, to: string) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

export function minutesBetween(start: string, end: string) {
  const [h1, m1] = start.split(":").map(Number);
  const [h2, m2] = end.split(":").map(Number);
  return h2 * 60 + m2 - (h1 * 60 + m1);
}
