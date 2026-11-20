/* Copie serveur de pedago-mobile/src/lib/prep-text.ts : lecture déterministe d'une fiche (sans IA). */
/** Fiche de préparation (toutes les rubriques sont facultatives). */
export type PrepContent = {
  objectives?: string[];
  materials?: string[];
  steps?: { name: string; durationMin: number; teacherActivities: string[]; learnerActivities: string[] }[];
  writtenTrace?: string;
  exercises?: { prompt: string; answer: string }[];
  notes?: string;
};

/** Champs texte de l'éditeur de fiche : une idée par ligne. */
export type PrepForm = { objectives: string; materials: string; steps: string; writtenTrace: string; exercises: string; notes: string };

export const EMPTY_FORM: PrepForm = { objectives: '', materials: '', steps: '', writtenTrace: '', exercises: '', notes: '' };

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•–·]|\d+[).]|[a-z][).])\s*/i, '').trim())
    .filter(Boolean);

/** « Découverte (10 min) : lecture de l'énoncé ; questions » → étape. */
function parseStep(line: string) {
  const [head, ...rest] = line.split(/\s*:\s*/);
  const minutes = /(\d{1,3})\s*(?:min|mn|')/i.exec(head)?.[1];
  const name = head.replace(/[(\[]?\s*\d{1,3}\s*(?:min|mn|')\w*\s*[)\]]?/i, '').replace(/[\s·–-]+$/, '').trim() || 'Étape';
  const activities = rest.join(' : ').split(/\s*;\s*/).filter(Boolean);
  return { name: name.slice(0, 160), durationMin: Math.min(120, Math.max(1, Number(minutes) || 10)), teacherActivities: activities.slice(0, 15), learnerActivities: [] };
}

/** « Calcule 3 + 4 → 7 » ou « Calcule 3 + 4 | 7 » → exercice avec corrigé. */
function parseExercise(line: string) {
  const [prompt, answer = ''] = line.split(/\s*(?:→|->|\|)\s*/);
  return { prompt: prompt.slice(0, 2000), answer: answer.slice(0, 2000) };
}

export function formToContent(f: PrepForm): PrepContent {
  const content: PrepContent = {};
  const o = lines(f.objectives);
  const m = lines(f.materials).flatMap((l) => l.split(/\s*[,;]\s*/)).filter(Boolean);
  const s = lines(f.steps);
  const e = lines(f.exercises);
  if (o.length) content.objectives = o.slice(0, 12);
  if (m.length) content.materials = m.slice(0, 20);
  if (s.length) content.steps = s.slice(0, 12).map(parseStep);
  if (f.writtenTrace.trim()) content.writtenTrace = f.writtenTrace.trim().slice(0, 4000);
  if (e.length) content.exercises = e.slice(0, 30).map(parseExercise);
  if (f.notes.trim()) content.notes = f.notes.trim().slice(0, 6000);
  return content;
}

export function contentToForm(c: PrepContent | null | undefined): PrepForm {
  if (!c) return { ...EMPTY_FORM };
  return {
    objectives: (c.objectives ?? []).join('\n'),
    materials: (c.materials ?? []).join('\n'),
    steps: (c.steps ?? []).map((s) => `${s.name} (${s.durationMin} min)${s.teacherActivities.length ? ' : ' + s.teacherActivities.join(' ; ') : ''}`).join('\n'),
    writtenTrace: c.writtenTrace ?? '',
    exercises: (c.exercises ?? []).map((e) => (e.answer ? `${e.prompt} → ${e.answer}` : e.prompt)).join('\n'),
    notes: c.notes ?? '',
  };
}

const HEADINGS: [keyof PrepForm, RegExp][] = [
  ['objectives', /^(objectifs?|compétences?|objectives?)\b/i],
  ['materials', /^(mat[ée]riel|supports?|materials?)\b/i],
  ['steps', /^(d[ée]roulement|d[ée]marche|[ée]tapes|phases|procedure|steps)\b/i],
  ['writtenTrace', /^(trace [ée]crite|r[ée]sum[ée]|synth[èe]se|le[çc]on [àa] retenir|je retiens|summary)\b/i],
  ['exercises', /^(exercices?|[ée]valuation|application|exercises?)\b/i],
  ['notes', /^(notes?|remarques?|observations?|remediation|rem[ée]diation)\b/i],
];

/**
 * Lit une fiche collée telle quelle : chaque titre reconnu (« Objectifs », « Matériel », « Déroulement »,
 * « Trace écrite », « Exercices », « Remarques ») ouvre sa rubrique. Le texte sans titre va dans les notes.
 */
export function parsePastedPrep(text: string): PrepForm {
  const out: PrepForm = { ...EMPTY_FORM };
  let current: keyof PrepForm = 'notes';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bare = line.replace(/^(?:[#*\s-]+|\d+[.)]\s*|[IVX]+[.)]\s*)+/, '');
    // Un titre est seul sur sa ligne ou suivi de « : » (« Synthèse (10 min) : … » reste une étape).
    let after = '';
    const hit = HEADINGS.find(([, re]) => {
      const m = re.exec(bare);
      if (!m) return false;
      const rest = bare.slice(m[0].length).trim();
      if (rest && !rest.startsWith(':')) return false;
      after = rest.replace(/^:\s*/, '');
      return true;
    });
    if (hit) {
      current = hit[0];
      if (after) out[current] += (out[current] ? '\n' : '') + after;
      continue;
    }
    out[current] += (out[current] ? '\n' : '') + line;
  }
  return out;
}
