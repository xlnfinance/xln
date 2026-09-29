import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Build dist/ before the suite — the tests exercise the real bin (`node dist/cli.js`). */
export default function globalSetup(): void {
  execFileSync("pnpm", ["build"], { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: "inherit" });
}
