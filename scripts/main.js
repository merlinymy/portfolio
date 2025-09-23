import { animateSphere } from "./canvas3d.js";
import { projectArr } from "../assets/projectsArray.js";
import { createProjectCard, populateProjectSection } from "./projects.js";
import { skillArr } from "../assets/skills.js";
import { buildSkillCard, populateSkillGrid } from "./skillsGrid.js";

const projectCards = projectArr.map((project) => createProjectCard(project));
populateProjectSection(projectCards);
const skillCards = skillArr.map((skill) => buildSkillCard(skill));
populateSkillGrid(skillCards);

const menuBtn = document.querySelector(".menu-icon");
const popupMenu = document.querySelector(".dropdown");
const html = document.querySelector("html");
menuBtn.addEventListener("click", () => {
  popupMenu.classList.toggle("hidden");
  html.classList.toggle("noscroll");
});

const popupItems = document.querySelectorAll(".dropdown li");
popupItems.forEach((item) => {
  item.addEventListener("click", () => {
    popupMenu.classList.toggle("hidden");
    html.classList.toggle("noscroll");
  });
});

document.querySelector(".download-resume").addEventListener("click", () => {
  window.open("/Merlin_Yang_Resume.pdf", "_blank");
});

animateSphere();

// Apply glow effects on mobile with intersection observer
// https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API

let projectPrevThreshold = 0.0;
let skillPrevThreshold = 0.0;

const projectCardIOOptions = {
  root: null,
  threshold: 0.75,
};

const skillCardIOOptions = {
  root: null,
  threshold: 1,
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

const skillIOCallback = (entries) => {
  entries.forEach((entry) => {
    if (entry.intersectionRatio > skillPrevThreshold) {
      entry.target.classList.add("mobile-in-view");
    } else {
      entry.target.classList.remove("mobile-in-view");
    }
    skillPrevThreshold = entry.intersectionRatio;
  });
};
const projectObserver = new IntersectionObserver(
  projectIOCallback,
  projectCardIOOptions
);
const skillObserver = new IntersectionObserver(
  skillIOCallback,
  skillCardIOOptions
);
projectCards.forEach((card) => projectObserver.observe(card));
skillCards.forEach((card) => skillObserver.observe(card));
