// src/ai/template.ts
//
// Generic Handlebars-based template renderer. Used by every AI prompt that
// needs structured interpolation. Lives under src/ai/ because it is generic
// and was previously duplicated under src/review/template.ts.
//
// Helpers:
//   - {{json value}}       → JSON.stringify(value, null, 2)
//   - {{joinLines lines}}  → array joined by newline
//
// Add new helpers here only when at least two unrelated callers need them.

import Handlebars from "handlebars";

const handlebars = Handlebars.create();

handlebars.registerHelper("json", (value: unknown): string => JSON.stringify(value, null, 2));
handlebars.registerHelper("joinLines", (value: unknown): string => {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.join("\n");
});

export function renderTemplate(template: string, context: Record<string, unknown> = {}): string {
  return handlebars.compile(template, { noEscape: true })(context);
}
