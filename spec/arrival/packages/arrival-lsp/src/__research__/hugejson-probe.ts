import { createSchemeLanguageService } from "../language-service.js";

function hugeJson(width: number, withReads: boolean) {
  const e: string[] = [];
  for (let i = 0; i < width; i++) {
    e.push(
      i % 5 === 0
        ? `:k${i} (dict :a${i} ${i} :b${i} (dict :c${i} "v${i}"))`
        : i % 2 === 0
          ? `:k${i} ${i}`
          : `:k${i} "s${i}"`,
    );
  }
  const lines = [`(define data (dict ${e.join(" ")}))`];
  if (withReads) {
    for (let i = 0; i < width; i += 3) {
      lines.push(
        i % 5 === 0 ? `(define r${i} (path (list :k${i} :b${i} :c${i}) data))` : `(define r${i} (prop :k${i} data))`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
for (const W of [500, 1000, 2000]) {
  for (const reads of [false, true]) {
    const prog = hugeJson(W, reads);
    const svc = createSchemeLanguageService();
    let t = performance.now();
    svc.getSemanticDiagnostics(prog);
    const cold = performance.now() - t;
    t = performance.now();
    for (let r = 0; r < 3; r++) svc.getSemanticDiagnostics(prog);
    const warm = (performance.now() - t) / 3;
    console.log(
      `W=${String(W).padStart(4)} reads=${reads ? "Y" : "n"} | COLD diag=${cold.toFixed(0)}ms | WARM diag=${warm.toFixed(0)}ms | bytes=${prog.length}`,
    );
  }
}
