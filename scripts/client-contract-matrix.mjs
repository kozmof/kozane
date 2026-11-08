/** Read operation names from the first table column without depending on Markdown padding.
 * @param {string} markdown
 * @returns {string[]}
 */
export function matrixOperations(markdown) {
  return [...markdown.matchAll(/^[\t ]*\|[\t ]*`([\w.]+)`[\t ]*\|/gm)].map((match) => match[1]);
}
