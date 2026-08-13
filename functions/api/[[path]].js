import { handleApi } from "../../src/api.js";

export async function onRequest(context) {
  const response = await handleApi(context.request, context.env);
  if (response) return response;
  return new Response("Not found", { status: 404 });
}
