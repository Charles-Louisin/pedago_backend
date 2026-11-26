import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let memoryServer: { stop: () => Promise<boolean> } | null = null;

/** Nom de base de l'adresse, s'il y en a un (« mongodb+srv://hôte/pedago?… » → « pedago »). */
export function uriDbName(uri: string) {
  return uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?]+)/)?.[1];
}

export async function connectDb() {
  mongoose.set("strictQuery", true);
  const options = {
    dbName: uriDbName(env.mongoUri) ?? env.mongoDb,
    maxPoolSize: Number(process.env.MONGO_MAX_POOL || 40),
    minPoolSize: 2,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 5_000,
  };
  try {
    await mongoose.connect(env.mongoUri, options);
    logger.info("MongoDB connecté");
  } catch (err) {
    if (!env.mongoMemoryFallback) throw err;
    logger.warn("MongoDB injoignable : démarrage d'une base locale de développement (.data/mongo)");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const fs = await import("node:fs");
    const dbPath = `${process.cwd()}/.data/mongo`;
    fs.mkdirSync(dbPath, { recursive: true });
    // Données conservées entre deux redémarrages (nodemon) pour ne pas perdre les comptes de test.
    const server = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: "wiredTiger", port: 27027 } });
    memoryServer = server;
    await mongoose.connect(server.getUri("pedago"), options);
    const { seedDatabase } = await import("../seed/seed.js");
    await seedDatabase();
  }
  await migrateRoles();
}

/** Deux rôles seulement : les anciens comptes « relecteur » deviennent administrateurs (le relecteur est l'admin). */
async function migrateRoles() {
  const out = await mongoose.connection.collection("users").updateMany({ role: "reviewer" }, { $set: { role: "admin" } });
  if (out.modifiedCount) logger.info({ count: out.modifiedCount }, "Comptes relecteur passés administrateur");
}

export async function disconnectDb() {
  await mongoose.disconnect();
  await memoryServer?.stop();
}
