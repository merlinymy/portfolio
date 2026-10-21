import type { APIRoute } from "astro";
import { buildLlmsTxt } from "../lib/profile";

// The proposed llms.txt convention: a short Markdown index for AI tools (plan §4.3).
export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error("Set `site` in astro.config.mjs");
  return new Response(await buildLlmsTxt(site), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
