import mongoose from "mongoose";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

let memoryServer: { stop: () => Promise<boolean> } | null = null;

export async function connectDb() {
  mongoose.set("strictQuery", true);
  const options = {
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
    logger.warn("MongoDB injoignable : démarrage d'une base en mémoire (développement, données non persistées)");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    const server = await MongoMemoryServer.create();
    memoryServer = server;
    await mongoose.connect(server.getUri("pedago"), options);
    const { seedDatabase } = await import("../seed/seed.js");
    await seedDatabase();
  }
}

export async function disconnectDb() {
  await mongoose.disconnect();
  await memoryServer?.stop();
}
