import pino from "pino";
import { isProduction } from "../config/env.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
  redact: {
    paths: ["req.headers.authorization", "password", "*.password", "*.passwordHash", "refreshToken", "*.refreshToken"],
    censor: "[masqué]",
  },
});
