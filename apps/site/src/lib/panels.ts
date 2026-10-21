/**
 * The six profile buttons and the panels they open (plan §4.2). The page renders them as a plain
 * <nav> of links; the face island will read the same list to float them around the head.
 */
export const PANELS = [
  { id: "about", label: "About" },
  { id: "experience", label: "Experience" },
  { id: "projects", label: "Projects" },
  { id: "skills", label: "Skills" },
  { id: "resume", label: "Résumé" },
  { id: "contact", label: "Contact" },
] as const;
