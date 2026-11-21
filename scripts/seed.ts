import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { seedDatabase } from "../src/seed/seed.js";
import { uriDbName } from "../src/db/connect.js";

await mongoose.connect(env.mongoUri, { dbName: uriDbName(env.mongoUri) ?? env.mongoDb });
await seedDatabase();
await mongoose.disconnect();
