import { crawlNow, handleApi } from "./api.js";

export default {
  async fetch(request, env) {
    const apiResponse = await handleApi(request, env);
    if (apiResponse) return apiResponse;
    if (env?.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env) {
    try {
      await crawlNow(env, new Request("https://assets.local/"));
      return new Response("ok");
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
