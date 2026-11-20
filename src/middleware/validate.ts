import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

/** Valide et remplace body/query par la version analysée (champs inconnus retirés). */
export function validate(schema: ZodSchema, source: "body" | "query" | "params" = "body") {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req[source]);
      if (source === "query") Object.defineProperty(req, "query", { value: parsed, writable: true });
      else (req as any)[source] = parsed;
      next();
    } catch (err) {
      next(err);
    }
  };
}
