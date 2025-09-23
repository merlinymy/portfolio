import { animateSphere } from "./canvas3d.js";
import { projectArr } from "../assets/projectsArray.js";
import { createProjectCard, populateProjectSection } from "./projects.js";
import { skillArr } from "../assets/skills.js";
import { buildSkillCard, populateSkillGrid } from "./skillsGrid.js";

const projectCards = projectArr.map((project) => createProjectCard(project));
populateProjectSection(projectCards);
const skillCards = skillArr.map((skill) => buildSkillCard(skill));
console.log(skillCards);
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
  window.open("/assets/Merlin_Yang_Resume.pdf", "_blank");
});

animateSphere();
