export class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (code = "BAD_REQUEST", message = "Requête invalide") => new HttpError(400, code, message);
export const unauthorized = (message = "Authentification requise") => new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (code = "FORBIDDEN", message = "Accès refusé") => new HttpError(403, code, message);
export const notFound = (message = "Introuvable") => new HttpError(404, "NOT_FOUND", message);
export const conflict = (code = "CONFLICT", message = "Conflit") => new HttpError(409, code, message);

/** Enveloppe un handler async pour transmettre les erreurs au middleware d'erreurs. */
export function ah<T extends (...args: any[]) => Promise<unknown>>(fn: T) {
  return (req: any, res: any, next: any) => {
    fn(req, res, next).catch(next);
  };
}
