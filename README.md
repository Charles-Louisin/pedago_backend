# PEDAGO — API

API Express + MongoDB de PEDAGO : préparation et suivi pédagogique des enseignants du primaire camerounais.

## Démarrer

```bash
npm install
cp .env.example .env
npm run dev
```

Sans MongoDB local, l'API démarre une base **en mémoire** (développement uniquement) et y charge les données de démonstration.
Avec une vraie base : `npm run seed`.

Comptes de test : voir les variables `SEED_*` de `.env.example`.

## Architecture

Monolithe modulaire + worker IA séparé.

| Dossier | Rôle |
| --- | --- |
| `src/modules/auth.ts` | Inscription, connexion, jetons d'accès courts + refresh tournant, sessions par appareil, verrouillage après échecs |
| `src/modules/teacher.ts` | Profil pédagogique, emploi du temps, programme du jour, synchronisation hors connexion, rattrapage, couverture, cahier de textes |
| `src/modules/library.ts` | Bibliothèque publiée, traçabilité des sources, exports PDF/Word, manifestes de téléchargement (jour/trimestre/année) |
| `src/modules/admin.ts` | Sources, référentiel, relecture et validation humaine, publication versionnée, tâches IA, coûts, calendrier, utilisateurs, audit |
| `src/services/planning.ts` | Moteur déterministe de planification et de rattrapage (aucun appel IA) |
| `src/ai/` | Client OpenRouter avec budget par tâche, prompts versionnés, protection SSRF, pipeline par étapes reprenables, worker |

### Principes

- L'usage quotidien de l'app n'appelle **jamais** l'IA : l'IA sert uniquement à construire la bibliothèque côté admin.
- Cycle éditorial : `DRAFT → AI_CHECKED → HUMAN_REVIEW → APPROVED → PUBLISHED`. Une ressource IA ne peut pas être publiée sans validation humaine ni source citée.
- Chaque génération a une clé (`generationKey`) : une ressource existante n'est jamais régénérée par erreur.
- Les exports PDF/Word sont générés une seule fois par version, puis réutilisés.
- Synchronisation hors connexion : journal d'événements avec `opId` unique (idempotent).
- Les séances manquées restent dans la file de rattrapage jusqu'à décision de l'enseignant.

### Worker IA

En développement il tourne dans le processus API. En production :
`AI_WORKER_IN_PROCESS=false` côté API, et `npm run start:worker` sur un service dédié.

## À valider avant production

- Les matières, leçons et le calendrier du seed sont des **exemples** : à remplacer par le référentiel extrait des documents officiels MINEDUB et validé humainement.
- Choix des modèles OpenRouter : à comparer sur un jeu de tests réel évalué par des enseignants.
- Points juridiques (loi 2021/024 sur le livre, droit d'auteur, loi 2024/017 sur les données personnelles) à faire examiner par un juriste camerounais.
