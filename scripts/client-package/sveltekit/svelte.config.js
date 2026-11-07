import adapter from "@sveltejs/adapter-static";
export default {
  kit: {
    adapter: adapter(),
    paths: { base: "/kit" },
    prerender: {
      // These fragments carry filters rather than DOM anchor identifiers.
      handleMissingId: ({ id }) => {
        const keys = [...new URLSearchParams(id).keys()];
        if (!keys.length || keys.some((key) => key !== "tag" && key !== "day")) {
          throw new Error(`Unexpected missing anchor ${id}`);
        }
      },
    },
  },
};
