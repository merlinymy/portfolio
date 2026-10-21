import { getCollection, getEntry, type CollectionEntry } from "astro:content";

type Ordered = { data: { order: number } };
const byOrder = (a: Ordered, b: Ordered) => a.data.order - b.data.order;

export async function getAbout() {
  const about = await getEntry("about", "about");
  if (!about) throw new Error("content/about.md is missing");
  return about;
}

export const getExperience = async () => (await getCollection("experience")).sort(byOrder);
export const getProjects = async () => (await getCollection("projects")).sort(byOrder);
export const getEarlierProjects = async () => (await getCollection("earlierProjects")).sort(byOrder);
export const getSkills = async () => (await getCollection("skills")).sort(byOrder);
export const getInstantAnswers = async () => (await getCollection("instant")).sort(byOrder);

/** schema.org ProfilePage + Person, which search engines read directly (plan §4.3). */
export function personJsonLd(
  about: CollectionEntry<"about">,
  skills: CollectionEntry<"skills">[],
  site: URL,
) {
  const { data } = about;
  const schools = [...new Set(data.education.map((e) => e.school))];
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: site.href,
    mainEntity: {
      "@type": "Person",
      name: data.name,
      url: site.href,
      jobTitle: data.headline,
      description: data.tagline,
      sameAs: [data.contact.linkedin, data.contact.github],
      alumniOf: schools.map((name) => ({ "@type": "CollegeOrUniversity", name })),
      knowsAbout: skills
        .filter((s) => s.id === "languages" || s.id === "ai")
        .flatMap((s) => s.data.items),
    },
  };
}

/** The whole public profile as one Markdown document, served at /profile.md for AI crawlers. */
export async function buildProfileMarkdown(site: URL): Promise<string> {
  const [about, experience, projects, earlier, skills, instant] = await Promise.all([
    getAbout(),
    getExperience(),
    getProjects(),
    getEarlierProjects(),
    getSkills(),
    getInstantAnswers(),
  ]);
  const { data } = about;
  const linkList = (links: { label: string; url: string }[]) =>
    links.map((l) => `[${l.label}](${l.url})`).join(" · ");

  const lines = [
    `# ${data.name}`,
    "",
    `${data.headline} · ${data.location}`,
    "",
    data.summary,
    "",
    "## About",
    "",
    about.body?.trim() ?? "",
    "",
    `- ${data.workAuthorization}`,
    ...data.education.map(
      (e) => `- ${e.degree}, ${e.school} (${e.date}${e.note ? `; ${e.note}` : ""})`,
    ),
    ...data.credentials.map((c) => `- ${c}`),
    "",
    "## Experience",
  ];

  for (const job of experience) {
    const d = job.data;
    lines.push("", `### ${d.role}, ${d.company}`, "", [d.dates, d.location].filter(Boolean).join(" · "));
    if (d.about) lines.push("", d.about);
    lines.push("", job.body?.trim() ?? "");
  }

  lines.push("", "## Projects");
  for (const project of projects) {
    const d = project.data;
    lines.push("", `### ${d.name} (${d.dates})`, "", d.blurb, "", `Tech: ${d.tech.join(", ")}`);
    lines.push("", project.body?.trim() ?? "");
    if (d.links.length > 0) lines.push("", linkList(d.links));
  }

  lines.push("", "### Earlier frontend projects", "");
  for (const { data: p } of earlier) {
    lines.push(`- **${p.name}**: ${p.desc} (${p.tech.join(", ")}) ${linkList(p.links)}`);
  }

  lines.push("", "## Skills", "", ...skills.map((s) => `- **${s.data.group}:** ${s.data.items.join(", ")}`));

  lines.push("", "## Common questions");
  for (const { data: q } of instant) lines.push("", `### ${q.question}`, "", q.answer);

  lines.push(
    "",
    "## Contact",
    "",
    `- Email: ${data.contact.email}`,
    `- LinkedIn: ${data.contact.linkedin}`,
    `- GitHub: ${data.contact.github}`,
    `- Résumé (PDF): ${new URL(data.resumePdf, site).href}`,
    "",
  );
  return lines.join("\n");
}

/** /llms.txt: a short Markdown index for AI tools, pointing at the full profile (plan §4.3). */
export async function buildLlmsTxt(site: URL): Promise<string> {
  const { data } = await getAbout();
  const url = (path: string) => new URL(path, site).href;
  return [
    `# ${data.name}`,
    "",
    `> ${data.tagline}`,
    "",
    data.summary,
    "",
    "## Profile",
    "",
    `- [Full profile in Markdown](${url("/profile.md")}): experience, projects, skills, education, and answers to common recruiter questions`,
    `- [Résumé (PDF)](${url(data.resumePdf)})`,
    `- [Home page](${url("/")})`,
    "",
    "## Contact",
    "",
    `- [LinkedIn](${data.contact.linkedin})`,
    `- [GitHub](${data.contact.github})`,
    `- Email: ${data.contact.email}`,
    "",
  ].join("\n");
}
