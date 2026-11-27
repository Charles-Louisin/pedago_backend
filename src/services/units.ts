import { Types } from "mongoose";
import { CurriculumNode } from "../models/index.js";

/** Unité (ou séquence) d'une leçon, et place de la leçon dans cette unité. */
export type LessonUnit = {
  id: string;
  /** Intitulé écrit sur le document (« Unité 3 », « Séquence 2 ») ; absent pour le programme officiel. */
  label: string | null;
  title: string;
  /** Numéro de l'unité dans la matière (1, 2, 3…), pour afficher « Unité 3 » quand le document n'en donne pas. */
  number: number;
  /** Place de la leçon dans l'unité (1 = première) et nombre de leçons de l'unité. */
  lessonIndex: number;
  lessonCount: number;
};

type Row = { _id: Types.ObjectId; kind: string; parentId?: Types.ObjectId | null; order?: number; label?: string | null; title: string; importId?: Types.ObjectId | null; curriculumVersion?: string };

/**
 * Pour chaque leçon demandée : son unité (l'ancêtre de type « unit » le plus proche) et sa place dans l'unité.
 * Calcul en mémoire sur l'arbre de la matière (une requête par matière et par propriétaire) ; une leçon
 * sans unité dans l'arbre n'apparaît pas dans le résultat.
 */
export async function lessonUnits(lessonIds: (string | Types.ObjectId)[]): Promise<Map<string, LessonUnit>> {
  const out = new Map<string, LessonUnit>();
  const ids = [...new Set(lessonIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!ids.length) return out;
  const lessons = await CurriculumNode.find({ _id: { $in: ids }, parentId: { $ne: null } })
    .select("_id ownerId classLevel subjectCode")
    .lean();
  const groups = new Map<string, { ownerId: unknown; classLevel: string; subjectCode: string; lessonIds: string[] }>();
  for (const l of lessons) {
    const key = `${l.ownerId ?? "-"}|${l.classLevel}|${l.subjectCode}`;
    const g = groups.get(key) ?? { ownerId: l.ownerId ?? null, classLevel: l.classLevel, subjectCode: l.subjectCode, lessonIds: [] };
    g.lessonIds.push(String(l._id));
    groups.set(key, g);
  }
  await Promise.all(
    [...groups.values()].map(async (g) => {
      const tree = await CurriculumNode.find({ ownerId: g.ownerId, classLevel: g.classLevel, subjectCode: g.subjectCode })
        .select("_id kind parentId order label title importId curriculumVersion")
        .lean<Row[]>();
      const byId = new Map(tree.map((n) => [String(n._id), n]));
      const unitOf = (id: string) => {
        let cur = byId.get(id);
        for (let depth = 0; cur?.parentId && depth < 8; depth++) {
          cur = byId.get(String(cur.parentId));
          if (cur?.kind === "unit") return cur;
        }
        return null;
      };
      // Leçons de chaque unité (dans l'ordre), et numéro des unités au sein d'un même import / programme.
      const lessonsByUnit = new Map<string, Row[]>();
      for (const n of tree) {
        if (n.kind !== "lesson") continue;
        const u = unitOf(String(n._id));
        if (u) lessonsByUnit.set(String(u._id), [...(lessonsByUnit.get(String(u._id)) ?? []), n]);
      }
      const batch = (n: Row) => `${n.importId ?? ""}|${n.curriculumVersion ?? ""}`;
      const unitNumber = new Map<string, number>();
      const unitsByBatch = new Map<string, Row[]>();
      for (const n of tree) if (n.kind === "unit") unitsByBatch.set(batch(n), [...(unitsByBatch.get(batch(n)) ?? []), n]);
      for (const units of unitsByBatch.values()) {
        units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach((u, i) => unitNumber.set(String(u._id), i + 1));
      }
      for (const id of g.lessonIds) {
        const u = unitOf(id);
        if (!u) continue;
        const siblings = (lessonsByUnit.get(String(u._id)) ?? []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        out.set(id, {
          id: String(u._id),
          label: u.label?.trim() || null,
          title: u.title,
          number: unitNumber.get(String(u._id)) ?? 1,
          lessonIndex: siblings.findIndex((s) => String(s._id) === id) + 1,
          lessonCount: siblings.length,
        });
      }
    })
  );
  return out;
}
