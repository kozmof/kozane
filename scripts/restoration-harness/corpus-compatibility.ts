export type CorpusCompatibility = "same" | "incompatible";
/** Only a known earlier bundled migration can use incompatible-copy fallback. */
export function migrationCompatibility(
  producerId: string,
  candidateId: string,
  migrationIds: readonly string[],
): CorpusCompatibility {
  if (
    !candidateId ||
    !migrationIds.length ||
    migrationIds.at(-1) !== candidateId ||
    migrationIds.some((id) => !id) ||
    new Set(migrationIds).size !== migrationIds.length
  )
    throw new Error("Candidate migration history must be unique and end at its current ID");
  if (!migrationIds.includes(producerId))
    throw new Error(`Unknown retained producer migration ID: ${producerId}`);
  return producerId === candidateId ? "same" : "incompatible";
}
/** A new migration ID needs its own positive fixtures before a release check can pass. */
export function planCorpusCompatibility(
  producerIds: readonly string[],
  candidateId: string,
  migrationIds: readonly string[],
): readonly CorpusCompatibility[] {
  const plan = producerIds.map((id) => migrationCompatibility(id, candidateId, migrationIds));
  if (!plan.includes("same"))
    throw new Error(
      "Retain a producer cohort for the candidate's current migration ID before release",
    );
  return Object.freeze(plan);
}
