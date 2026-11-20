import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { seedDatabase } from "../src/seed/seed.js";

await mongoose.connect(env.mongoUri);
await seedDatabase();
await mongoose.disconnect();
