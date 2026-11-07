import { resolve } from "node:path";
import { checkCorpusRetention } from "./retention.mjs";
const result = checkCorpusRetention(resolve(import.meta.dirname, "../.."));
console.log(
  `Corpus retention passed for ${result.cohorts} cohorts against ${result.revisions} historical indexes.`,
);
