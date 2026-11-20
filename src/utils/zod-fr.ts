import { z, ZodIssueCode } from "zod";

/** Messages de validation en français (les messages affichés à l'enseignant ne doivent pas être techniques). */
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") return { message: "Champ obligatoire manquant" };
      return { message: "Format de donnée invalide" };
    case ZodIssueCode.too_small:
      return { message: issue.type === "string" ? `Au moins ${issue.minimum} caractère(s)` : issue.type === "array" ? `Au moins ${issue.minimum} élément(s)` : `Valeur trop petite (minimum ${issue.minimum})` };
    case ZodIssueCode.too_big:
      return { message: issue.type === "string" ? `Au plus ${issue.maximum} caractères` : issue.type === "array" ? `Au plus ${issue.maximum} éléments` : `Valeur trop grande (maximum ${issue.maximum})` };
    case ZodIssueCode.invalid_enum_value:
      return { message: "Valeur non autorisée" };
    case ZodIssueCode.invalid_string:
      return { message: issue.validation === "email" ? "Adresse e-mail invalide" : issue.validation === "url" ? "Adresse web invalide" : "Format invalide" };
    case ZodIssueCode.unrecognized_keys:
      return { message: "Champs non autorisés" };
    default:
      return { message: ctx.defaultError };
  }
});
