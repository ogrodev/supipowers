import Handlebars from "handlebars";

const handlebars = Handlebars.create();

handlebars.registerHelper("json", (value: unknown): string => JSON.stringify(value, null, 2));
handlebars.registerHelper("joinLines", (value: unknown): string => {
  if (!Array.isArray(value)) {
    return "";
  }
  return value.join("\n");
});

export function renderReviewTemplate(template: string, context: Record<string, unknown> = {}): string {
  return handlebars.compile(template, { noEscape: true })(context);
}
