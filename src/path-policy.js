import { realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const stripAt = (value) => value.startsWith("@") ? value.slice(1) : value;
const existing = (path) => { let current = path; for (;;) { try { return [current, realpathSync(current)]; } catch { const parent = dirname(current); if (parent === current) throw new Error("no existing parent"); current = parent; } } };
const within = (path, root) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && rel !== ".."); };
export function guardPath({ cwd, roots, paths, input, write }) {
  if (typeof input !== "string" || !input) throw new Error("missing path");
  const raw = stripAt(input); const lexical = resolve(cwd, raw); const lexicalRel = relative(resolve(roots[0]), lexical); if (lexicalRel === ".git" || lexicalRel.startsWith(`.git${sep}`) || lexicalRel.includes(`${sep}.git${sep}`)) throw new Error(".git is forbidden"); const canonicalRoot = realpathSync(roots[0]);
  let canonicalTarget; try { canonicalTarget = realpathSync(lexical); } catch { const [lexicalParent, canonicalParent] = existing(dirname(lexical)); canonicalTarget = resolve(canonicalParent, relative(lexicalParent, lexical)); }
  if (!within(canonicalTarget, canonicalRoot)) throw new Error("path escapes allowed root");
  const rel = relative(canonicalRoot, canonicalTarget); if (rel === ".git" || rel.startsWith(`.git${sep}`) || rel.includes(`${sep}.git${sep}`)) throw new Error(".git is forbidden");
  if (write && !paths.some((scope) => within(canonicalTarget, resolve(canonicalRoot, scope)))) throw new Error("path outside approved write scope");
  return lexical;
}
