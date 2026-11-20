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

## Sécurité des comptes

- Mots de passe : **Argon2id** (19 Mio, 2 passes). Les anciens hachages bcrypt sont convertis à la connexion suivante.
- Équipe (relecteurs, administrateurs) : **double authentification obligatoire** (TOTP, application d'authentification).
  Sans elle, toutes les routes `/admin` répondent `403 MFA_REQUIRED`. 8 codes de secours à usage unique ;
  un administrateur peut réinitialiser la 2FA d'une personne qui a perdu son téléphone (page Utilisateurs).
- Données personnelles : `GET /teacher/me/export` (copie complète en JSON) et `DELETE /auth/me`
  (suppression définitive, mot de passe requis, fichiers personnels compris).

## Sauvegardes

```bash
BACKUP_KEY=<32 octets en hex> MONGODB_URI=... npm run backup          # → backups/<date>/
BACKUP_KEY=... npm run restore -- backups/<date> --uri mongodb://hôte/base [--drop]
```

- Une collection = un fichier EJSON compressé et chiffré (AES-256-GCM) ; manifeste avec nombres de documents,
  empreintes SHA-256 et index. `BACKUP_KEY` est obligatoire en production.
- La restauration vérifie empreintes et déchiffrement **avant** d'écrire, refuse d'écraser une base non vide sans `--drop`,
  recrée les index et compare les nombres de documents.
- Rotation : les sauvegardes de plus de `BACKUP_RETENTION_DAYS` jours (30 par défaut) sont supprimées.
- À planifier chaque nuit et à copier hors du serveur. Les fichiers (UploadThing) ne sont pas dans cette sauvegarde.
- Garder `BACKUP_KEY` dans un coffre séparé : sans elle, les sauvegardes sont illisibles.

## Tests de charge

```bash
# instance de test dédiée (jamais la production), limiteur général désactivé
PORT=5199 MONGODB_URI=mongodb://hôte/pedago_load RATE_LIMIT_MAX=0 LOG_LEVEL=warn npm run start:cluster
MONGODB_URI=mongodb://hôte/pedago_load npm run seed
npm run load-test -- http://127.0.0.1:5199/api/v1 15 50
```

Parcours enseignant mesurés : accueil, recherche, fiche, manifeste de téléchargement, synchronisation de bilans,
grille annuelle, et coût Argon2id des connexions.

Référence (20/11/2026, poste de dev 4 cœurs, MongoDB local sur la même machine, 50 connexions, 2 processus API) :
0 erreur sur ~20 000 requêtes ; 118 req/s pour l'accueil (p50 373 ms), ~290 req/s pour la recherche et l'ouverture
d'une fiche (p50 ~160 ms), 150 req/s pour la synchronisation. Requête isolée : 5 à 12 ms ; sous charge, la limite
venait de la base locale partagée, pas de l'API. **À refaire sur l'infrastructure réelle** (MongoDB Atlas, serveur de production)
avant d'annoncer une capacité.

## À valider avant production

- Les matières, leçons et le calendrier du seed sont des **exemples** : à remplacer par le référentiel extrait des documents officiels MINEDUB et validé humainement.
- Choix des modèles OpenRouter : à comparer sur un jeu de tests réel évalué par des enseignants.
- Points juridiques (loi 2021/024 sur le livre, droit d'auteur, loi 2024/017 sur les données personnelles) à faire examiner par un juriste camerounais.
