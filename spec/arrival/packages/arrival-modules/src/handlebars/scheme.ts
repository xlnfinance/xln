/**
 * Pure `.hbs` bytes → scheme SOURCE for the import-executable face.
 *
 *   (lambda (arg . rest) (template/handlebars <src> (cons arg rest)))
 *
 * Equivalent to the historical fully-variadic `(lambda args …)` form (args =
 * the whole rest list), but spelled with a fixed first param so mercury's
 * coreform classify can lower it (unsupported-form/variadic-lambda rejects
 * bare-symbol params). Interpreter + compiler share this pretreat.
 *
 * Mercury: convert then `compileScmModule`. Not a special import path.
 */
export function hbsContentsToSchemeSource(contents: string): string {
  const src = JSON.stringify(String(contents));
  return `(lambda (arg . rest) (template/handlebars ${src} (cons arg rest)))`;
}
