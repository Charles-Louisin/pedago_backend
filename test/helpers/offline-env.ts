/**
 * À importer EN PREMIER dans un test : aucun service externe réel (UploadThing, OpenRouter).
 * dotenv ne remplace pas une variable déjà définie, même vide : les fichiers restent dans le dossier local
 * et les appels de modèle vont au faux serveur du test.
 */
process.env.UPLOADTHING_TOKEN = "";
process.env.OPENROUTER_API_KEY = "";
process.env.AI_WORKER_IN_PROCESS = "false";
process.env.RESEND_API_KEY = "";
