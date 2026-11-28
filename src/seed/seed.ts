import { hashPassword } from "../utils/password.js";
import { AcademicCalendar, CurriculumNode, Resource, Subject, TeacherProfile, Timetable, User } from "../models/index.js";
import { logger } from "../utils/logger.js";

/**
 * Données de DÉMONSTRATION pour le développement.
 * - Les matières et leçons ci-dessous illustrent la structure : elles doivent être remplacées par le référentiel
 *   extrait des programmes officiels MINEDUB et validé humainement.
 * - Le calendrier 2026-2027 est un exemple non vérifié (verified=false) : à aligner sur l'arrêté officiel.
 */

const SUBJECTS = {
  francophone: [
    ["MATH", "Mathématiques", "#0B7A4B", "calculator"],
    ["FR", "Langue et communication (français)", "#2F6FED", "book-open"],
    ["SCI", "Sciences et technologie", "#1A9E8F", "flask"],
    ["SHS", "Sciences humaines et sociales", "#C77700", "globe"],
    ["EN", "Anglais", "#7B4FD6", "message-circle"],
    ["LCN", "Langues et cultures nationales", "#B5452B", "users"],
    ["ART", "Éducation artistique", "#D6336C", "palette"],
    ["EPS", "Éducation physique et sportive", "#3B8B2E", "activity"],
    ["TIC", "Technologies de l'information", "#4A5568", "monitor"],
  ],
  anglophone: [
    ["MATH", "Mathematics", "#0B7A4B", "calculator"],
    ["ENG", "English Language", "#2F6FED", "book-open"],
    ["SCI", "Science and Technology", "#1A9E8F", "flask"],
    ["SOC", "Social Studies", "#C77700", "globe"],
    ["FRE", "French", "#7B4FD6", "message-circle"],
    ["NLC", "National Languages and Cultures", "#B5452B", "users"],
    ["ART", "Arts", "#D6336C", "palette"],
    ["PE", "Physical Education", "#3B8B2E", "activity"],
    ["ICT", "ICT", "#4A5568", "monitor"],
  ],
} as const;

const DEMO_LESSONS: Record<string, { classLevel: string; subsystem: "francophone" | "anglophone"; subjectCode: string; lessons: [string, string[], number?][] }> = {
  cpMath: {
    classLevel: "CP",
    subsystem: "francophone",
    subjectCode: "MATH",
    lessons: [
      ["Les nombres de 0 à 10", ["Compter des objets jusqu'à 10", "Lire et écrire les nombres de 0 à 10"]],
      ["Comparer des nombres jusqu'à 10", ["Utiliser plus que, moins que, autant que", "Ranger des nombres"]],
      ["L'addition sans retenue", ["Comprendre le sens de l'addition", "Calculer des sommes jusqu'à 10"]],
      ["Les nombres de 10 à 20", ["Compter jusqu'à 20", "Décomposer en dizaine et unités"]],
      ["La soustraction", ["Comprendre le sens du retrait", "Calculer des différences simples"]],
      ["Révision : nombres et opérations", ["Réinvestir les acquis"], 3],
      ["Les nombres de 20 à 30", ["Lire et écrire les nombres de 20 à 30", "Comparer des nombres de 20 à 30"]],
      ["La monnaie : les pièces en FCFA", ["Reconnaître les pièces de 5 à 100 FCFA", "Faire de petits achats fictifs"]],
      ["Mesurer des longueurs", ["Comparer des longueurs", "Mesurer avec une unité non conventionnelle"]],
      ["Révision : mesures et monnaie", ["Réinvestir les acquis"], 3],
    ],
  },
  cpFr: {
    classLevel: "CP",
    subsystem: "francophone",
    subjectCode: "FR",
    lessons: [
      ["Compréhension d'une courte histoire", ["Écouter une histoire", "Répondre à des questions simples"]],
      ["Le son [a]", ["Reconnaître le son [a]", "Écrire la lettre a"]],
      ["Le son [i]", ["Reconnaître le son [i]", "Lire des syllabes"]],
      ["Se présenter", ["Dire son nom, son âge, son village ou quartier"]],
      ["Le son [o]", ["Reconnaître le son [o]", "Lire des mots simples"]],
      ["Révision : sons et lecture", ["Réinvestir les acquis"], 3],
    ],
  },
  cpSci: {
    classLevel: "CP",
    subsystem: "francophone",
    subjectCode: "SCI",
    lessons: [
      ["Les parties d'une plante", ["Nommer racine, tige, feuille, fleur", "Observer une plante de l'environnement"]],
      ["Les parties du corps humain", ["Nommer les principales parties du corps"]],
      ["L'eau potable", ["Distinguer eau potable et eau non potable", "Citer des gestes d'hygiène"]],
      ["Les animaux domestiques", ["Citer des animaux domestiques du milieu", "Dire leur utilité"]],
    ],
  },
  c2Math: {
    classLevel: "CLASS_2",
    subsystem: "anglophone",
    subjectCode: "MATH",
    lessons: [
      ["Numbers 0 to 50", ["Count objects up to 50", "Read and write numbers to 50"]],
      ["Addition with regrouping", ["Add two-digit numbers with regrouping"]],
      ["Subtraction within 50", ["Subtract two-digit numbers"]],
      ["Money: coins and notes in FCFA", ["Identify coins and notes", "Solve simple market problems"]],
      ["Revision: numbers and money", ["Consolidate learning"], 3],
    ],
  },
  c2Eng: {
    classLevel: "CLASS_2",
    subsystem: "anglophone",
    subjectCode: "ENG",
    lessons: [
      ["Listening to a short story", ["Listen attentively", "Answer simple questions"]],
      ["Greetings and introductions", ["Greet people politely", "Introduce oneself"]],
      ["Reading short words", ["Blend sounds to read CVC words"]],
    ],
  },
};

function demoContent(title: string, objectives: string[], durationMin: number) {
  return {
    generalInfo: { durationMin, domain: "Démonstration" },
    competency: `Mobiliser les acquis liés à : ${title.toLowerCase()}`,
    objectives,
    prerequisites: ["Acquis de la leçon précédente"],
    materials: ["Bâtonnets, capsules ou cailloux", "Ardoises", "Tableau noir et craie"],
    lowResourceAlternatives: [
      "Remplacer les images imprimées par des dessins au tableau",
      "Utiliser des objets du quotidien : capsules, graines, cailloux",
    ],
    largeClassTips: ["Travail par groupes de 6 avec un chef de groupe", "Correction collective sur ardoise levée"],
    steps: [
      { name: "Situation-problème", durationMin: 5, teacherActivities: ["Présente une situation du marché du quartier"], learnerActivities: ["Écoutent et proposent des réponses"] },
      { name: "Découverte", durationMin: 15, teacherActivities: ["Guide la manipulation"], learnerActivities: ["Manipulent le matériel en groupes"] },
      { name: "Structuration", durationMin: 10, teacherActivities: ["Fait formuler la règle"], learnerActivities: ["Recopient la trace écrite"] },
      { name: "Application", durationMin: 10, teacherActivities: ["Propose des exercices"], learnerActivities: ["Font les exercices sur ardoise"] },
      { name: "Évaluation", durationMin: 5, teacherActivities: ["Pose deux questions de contrôle"], learnerActivities: ["Répondent individuellement"] },
    ],
    writtenTrace: `${title} : ${objectives.join(". ")}.`,
    exercises: [
      { prompt: "Maman achète 3 mangues puis 4 mangues au marché. Combien de mangues a-t-elle ?", answer: "3 + 4 = 7 mangues" },
      { prompt: "Ali a 9 bonbons, il en donne 2 à sa sœur. Combien lui en reste-t-il ?", answer: "9 - 2 = 7 bonbons" },
    ],
    assessment: [{ prompt: "Calcule 5 + 3.", answer: "5 + 3 = 8", points: 2, competency: objectives[0] }],
    localContext: ["Marché du quartier", "Vente de mangues et de bonbons"],
    body: "CONTENU DE DÉMONSTRATION — à remplacer par une ressource issue de la bibliothèque validée.",
  };
}

/**
 * Hors tests, AUCUNE donnée fictive : matières, classes, unités et leçons viennent uniquement des programmes
 * déposés dans Sources (et de leur analyse). Seul un compte administrateur est créé s'il n'en existe aucun,
 * à partir de SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
 * Les données de démonstration ne servent qu'aux tests automatisés (ou à SEED_DEMO=1, explicitement).
 */
export async function seedDatabase(opts: { demo?: boolean } = {}) {
  if (opts.demo === false) {
    await ensureAdmin();
    return;
  }
  for (const subsystem of ["francophone", "anglophone"] as const) {
    for (const [i, [code, name, color, icon]] of SUBJECTS[subsystem].entries()) {
      await Subject.updateOne({ subsystem, code }, { name, color, icon, order: i }, { upsert: true });
    }
  }

  await AcademicCalendar.updateOne(
    { schoolYear: "2026-2027" },
    {
      startsOn: "2026-09-07",
      endsOn: "2027-06-04",
      terms: [
        { number: 1, startsOn: "2026-09-07", endsOn: "2026-12-18" },
        { number: 2, startsOn: "2027-01-04", endsOn: "2027-03-26" },
        { number: 3, startsOn: "2027-04-12", endsOn: "2027-06-04" },
      ],
      breaks: [
        { label: "Fête nationale de la jeunesse (exemple)", startsOn: "2027-02-11", endsOn: "2027-02-11", kind: "holiday" },
        { label: "Vacances de Noël (exemple)", startsOn: "2026-12-19", endsOn: "2027-01-03", kind: "vacation" },
        { label: "Vacances de Pâques (exemple)", startsOn: "2027-03-27", endsOn: "2027-04-11", kind: "vacation" },
        { label: "Fête du travail", startsOn: "2027-05-01", endsOn: "2027-05-01", kind: "holiday" },
        { label: "Fête nationale", startsOn: "2027-05-20", endsOn: "2027-05-20", kind: "holiday" },
      ],
      verified: false,
    },
    { upsert: true }
  );

  if ((await CurriculumNode.countDocuments()) === 0) {
    for (const group of Object.values(DEMO_LESSONS)) {
      let order = 0;
      for (const [title, objectives, priority] of group.lessons) {
        order += 1;
        const node = await CurriculumNode.create({
          subsystem: group.subsystem,
          classLevel: group.classLevel,
          subjectCode: group.subjectCode,
          kind: "lesson",
          title,
          objectives,
          durationMin: 45,
          order,
          term: order <= 4 ? 1 : order <= 7 ? 2 : 3,
          priority: priority ?? 2,
          curriculumVersion: "demo-2026",
          status: "validated",
        });
        const types = ["lesson_plan", "exercises", "assessment"] as const;
        for (const type of types) {
          await Resource.create({
            type,
            subsystem: group.subsystem,
            classLevel: group.classLevel,
            subjectCode: group.subjectCode,
            nodeId: node._id,
            title: `${title}`,
            summary: "Contenu de démonstration (structure uniquement) — non issu de la bibliothèque validée.",
            durationMin: 45,
            content: demoContent(title, objectives, 45),
            curriculumVersion: "demo-2026",
            origin: "seed",
            status: "PUBLISHED",
            publishedAt: new Date(),
          });
        }
      }
    }
  }

  // Remédiation de démonstration : une fiche par leçon du programme officiel (ajoutée une seule fois).
  if (!(await Resource.exists({ type: "remediation", origin: "seed" }))) {
    const nodes = await CurriculumNode.find({ ownerId: null, curriculumVersion: "demo-2026", kind: "lesson" }).lean();
    await Resource.insertMany(
      nodes.map((node) => {
        const content = demoContent(node.title, node.objectives, 30);
        return {
          type: "remediation",
          subsystem: node.subsystem,
          classLevel: node.classLevel,
          subjectCode: node.subjectCode,
          nodeId: node._id,
          title: `Consolider : ${node.title}`,
          summary: "Exercices plus simples et activité concrète (démonstration).",
          durationMin: 30,
          difficulty: "easy",
          content: {
            ...content,
            steps: [
              { name: "Rappel concret", durationMin: 10, teacherActivities: ["Reprend la notion avec des objets du quotidien"], learnerActivities: ["Manipulent et verbalisent"] },
              { name: "Petits pas", durationMin: 15, teacherActivities: ["Propose des exercices très guidés"], learnerActivities: ["Travaillent en binômes"] },
              { name: "Mini-contrôle", durationMin: 5, teacherActivities: ["Pose une question par élève"], learnerActivities: ["Répondent sur ardoise"] },
            ],
          },
          curriculumVersion: "demo-2026",
          origin: "seed",
          status: "PUBLISHED",
          publishedAt: new Date(),
        };
      })
    );
  }

  const accounts = [
    { email: process.env.SEED_ADMIN_EMAIL || "admin@pedago.test", password: process.env.SEED_ADMIN_PASSWORD || "Pedago-Admin-2026!", fullName: "Administrateur PEDAGO", role: "admin" },
    { email: process.env.SEED_TEACHER_EMAIL || "enseignant@pedago.test", password: process.env.SEED_TEACHER_PASSWORD || "Pedago-Enseignant-2026!", fullName: "Enseignant démo", role: "teacher" },
  ];
  for (const a of accounts) {
    if (await User.exists({ email: a.email })) {
      await User.updateOne({ email: a.email }, { emailVerified: true });
      continue;
    }
    const user = await User.create({ email: a.email, fullName: a.fullName, role: a.role, emailVerified: true, passwordHash: await hashPassword(a.password) });
    if (a.role === "teacher") {
      await TeacherProfile.create({
        userId: user._id,
        subsystem: "francophone",
        teachingLanguage: "fr",
        schoolName: "École publique de démonstration",
        region: "Centre",
        schoolYear: "2026-2027",
        assignments: [{ classLevel: "CP", subjects: ["MATH", "FR", "SCI"] }],
        onboardingCompletedAt: new Date(),
      });
      const slots = [];
      for (let wd = 1; wd <= 5; wd++) {
        slots.push({ weekday: wd, start: "08:00", end: "09:00", subjectCode: "MATH" });
        slots.push({ weekday: wd, start: "09:00", end: "10:00", subjectCode: "FR" });
        if (wd % 2 === 1) slots.push({ weekday: wd, start: "10:30", end: "11:30", subjectCode: "SCI" });
      }
      await Timetable.create({ teacherId: user._id, classLevel: "CP", schoolYear: "2026-2027", slots });
    }
  }
  // Rattrapage des tailles de contenu pour les ressources créées avant ce champ.
  await Resource.updateMany({ $or: [{ contentBytes: { $exists: false } }, { contentBytes: 0 }] }, [{ $set: { contentBytes: { $bsonSize: "$content" } } }]);
  logger.info("Données de démonstration prêtes");
}

/** Premier administrateur d'une base neuve (jamais de mot de passe par défaut hors tests). */
async function ensureAdmin() {
  if (await User.exists({ role: "admin" })) return;
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (!email || !password) {
    logger.warn("Aucun administrateur : renseigne SEED_ADMIN_EMAIL et SEED_ADMIN_PASSWORD puis redémarre");
    return;
  }
  await User.create({ email, fullName: "Administrateur PEDAGO", role: "admin", emailVerified: true, passwordHash: await hashPassword(password) });
  logger.info({ email }, "Administrateur créé");
}
