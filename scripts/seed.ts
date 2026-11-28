import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { seedDatabase } from "../src/seed/seed.js";
import { uriDbName } from "../src/db/connect.js";

await mongoose.connect(env.mongoUri, { dbName: uriDbName(env.mongoUri) ?? env.mongoDb });
// Données de démonstration seulement sur demande explicite (SEED_DEMO=1) ; sinon, premier administrateur uniquement.
await seedDatabase({ demo: process.env.SEED_DEMO === "1" });
await mongoose.disconnect();
