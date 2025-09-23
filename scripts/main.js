import { animateSphere } from "./canvas3d.js";
import { projectArr } from "../assets/projectsArray.js";
import { createProjectCard, populateProjectSection } from "./projects.js";
import { skillArr } from "../assets/skills.js";
import { buildSkillCard, populateSkillGrid } from "./skillsGrid.js";

const projectCards = projectArr.map((project) => createProjectCard(project));
populateProjectSection(projectCards);
const skillCards = skillArr.map((skill) => buildSkillCard(skill));
populateSkillGrid(skillCards);

document.querySelector(".download-resume").addEventListener("click", () => {
  window.open("./public/Merlin_Yang_Resume.pdf", "_blank");
});

animateSphere();

// Apply glow effects on mobile with intersection observer
// https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API

let projectPrevThreshold = 0.3;

const projectCardIOOptions = {
  root: null,
  threshold: 0.55,
};

const projectIOCallback = (entries) => {
  entries.forEach((entry) => {
    if (entry.intersectionRatio > projectPrevThreshold) {
      entry.target.classList.add("mobile-in-view");
    } else {
      entry.target.classList.remove("mobile-in-view");
    }
    projectPrevThreshold = entry.intersectionRatio;
  });
};

const projectObserver = new IntersectionObserver(
  projectIOCallback,
  projectCardIOOptions
);
projectCards.forEach((card) => projectObserver.observe(card));
