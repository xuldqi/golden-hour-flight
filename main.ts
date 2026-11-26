/**
 * Golden Hour Flight — hand-in program.
 *
 * The grader runs `node main.ts` (Node 22) with the repository mounted
 * read-only. This program copies the playable game (game/, plain static
 * files) and the screenshots (screenshots/) into the output directory —
 * /output in the grader, $MAKEFUN_OUTPUT_DIR everywhere else — and writes
 * dossier.json there with buildDossier from the vendored make.fun library
 * (vendor/makefun-game.ts, the kit's copy, unchanged). The gate rebuilds
 * the dossier from the same files with the same library and compares it
 * byte for byte, so the build stays deterministic: no timestamps, no
 * randomness, no network.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-game.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

mkdirSync(out, { recursive: true });
cpSync(join(here, "game"), join(out, "game"), { recursive: true });
mkdirSync(join(out, "screenshots"), { recursive: true });
if (existsSync(join(here, "screenshots"))) {
  cpSync(join(here, "screenshots"), join(out, "screenshots"), { recursive: true });
}

// The scorer's caps, as the kit prescribes: only text_max_bytes shapes the
// dossier's bytes; the rest refuse anything the scorer itself would refuse
// (over 4 screenshots or one over 256 KiB, over 993 entries or 48 MiB in
// game/, or a path under game/ longer than 1000 bytes).
const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(out, "dossier.json"), dossier);

console.log(`golden-hour-flight: game + screenshots + dossier.json (${dossier.length} bytes) -> ${out}`);
