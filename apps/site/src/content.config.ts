import { defineCollection } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";

// Profile content lives in the repo-root content/ folder so the chat's search ingest reads the same
// files the panels are built from (plan §4.5). Loader paths resolve from apps/site/.
const CONTENT = "../../content";

const link = z.object({ label: z.string(), url: z.url() });

const about = defineCollection({
  loader: glob({ base: CONTENT, pattern: "about.md" }),
  schema: z.object({
    name: z.string(),
    headline: z.string(),
    tagline: z.string(),
    summary: z.string(),
    location: z.string(),
    workAuthorization: z.string(),
    education: z.array(
      z.object({
        degree: z.string(),
        school: z.string(),
        date: z.string(),
        note: z.string().optional(),
      }),
    ),
    credentials: z.array(z.string()).default([]),
    contact: z.object({ email: z.email(), linkedin: z.url(), github: z.url() }),
    resumePdf: z.string().startsWith("/"),
  }),
});

const experience = defineCollection({
  loader: glob({ base: `${CONTENT}/experience`, pattern: "*.md" }),
  schema: z.object({
    company: z.string(),
    role: z.string(),
    location: z.string().optional(),
    dates: z.string(),
    about: z.string().optional(),
    order: z.number(),
  }),
});

const projects = defineCollection({
  loader: glob({ base: `${CONTENT}/projects`, pattern: "*.md" }),
  schema: z.object({
    name: z.string(),
    blurb: z.string(),
    dates: z.string(),
    tech: z.array(z.string()),
    links: z.array(link).default([]),
    order: z.number(),
  }),
});

const earlierProjects = defineCollection({
  loader: file(`${CONTENT}/earlier-projects.yaml`),
  schema: z.object({
    name: z.string(),
    desc: z.string(),
    tech: z.array(z.string()),
    links: z.array(link),
    order: z.number(),
  }),
});

const skills = defineCollection({
  loader: file(`${CONTENT}/skills.yaml`),
  schema: z.object({ group: z.string(), items: z.array(z.string()), order: z.number() }),
});

// The six instant answers (plan §7.11).
const instant = defineCollection({
  loader: file(`${CONTENT}/instant.yaml`),
  schema: z.object({
    question: z.string(),
    alsoAskedAs: z.array(z.string()),
    answer: z.string(),
    order: z.number(),
  }),
});

export const collections = { about, experience, projects, earlierProjects, skills, instant };
