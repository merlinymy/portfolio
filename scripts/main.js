import { animateSphere } from "./floating.js";
import { projectArr } from "../assets/projectsArray.js";
import { createProjectCard, populateProjectSection } from "./projects.js";

animateSphere();
const projectCards = projectArr.map((project) => createProjectCard(project));
populateProjectSection(projectCards);
const menuBtn = document.querySelector(".menu-icon");
const popupMenu = document.querySelector(".dropdown");
menuBtn.addEventListener("click", () => {
  popupMenu.classList.toggle("hidden");
});
