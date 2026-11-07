export const prerender = true;
export const trailingSlash = "always";
export const entries = () =>
  ["board", "tags", "map", "editor", "namespaces"].map((view) => ({ view }));
/** @type {import('./$types').PageServerLoad} */
export const load = ({ params }) => {
  if (!["board", "tags", "map", "editor", "namespaces"].includes(params.view))
    throw new Error("Unknown view");
  return { view: params.view };
};
