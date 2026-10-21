import type { APIRoute } from "astro";
import { buildProfileMarkdown } from "../lib/profile";

// The whole public profile as plain Markdown, for AI tools (plan §4.3).
export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error("Set `site` in astro.config.mjs");
  return new Response(await buildProfileMarkdown(site), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
