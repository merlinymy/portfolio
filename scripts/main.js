import { animateSphere } from "./canvas3d.js";
import { projectArr } from "../assets/projectsArray.js";
import { createProjectCard, populateProjectSection } from "./projects.js";
import { skillArr } from "../assets/skills.js";
import { buildSkillCard, populateSkillGrid } from "./skillsGrid.js";

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

const setupProjectObserver = (projectCards) => {
  const projectObserver = new IntersectionObserver(
    projectIOCallback,
    projectCardIOOptions
  );
  projectCards.forEach((card) => projectObserver.observe(card));
};

// Project filtering
let filteredProjects = [...projectArr];
let projectGrid;

const renderProjects = (projects) => {
  projectGrid.innerHTML = "";
  const projectCards = projects.map((project) => createProjectCard(project));
  populateProjectSection(projectCards);
  setupProjectObserver(projectCards);
};

const filterByTag = (tag) => {
  projectGrid.classList.add("filtering");

  setTimeout(() => {
    if (tag === "all") {
      filteredProjects = [...projectArr];
    } else {
      filteredProjects = projectArr.filter(
        (project) => project.tags && project.tags.includes(tag)
      );
    }

    renderProjects(filteredProjects);

    setTimeout(() => {
      projectGrid.classList.remove("filtering");
    }, 50);
  }, 300);
};

const setupFilterEvents = () => {
  const filterButtons = document.querySelectorAll(
    ".project-filters .filter-btn"
  );

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.getAttribute("data-filter");

      // Update active state
      filterButtons.forEach((btn) => {
        btn.classList.remove("active");
        btn.setAttribute("aria-pressed", "false");
      });
      button.classList.add("active");
      button.setAttribute("aria-pressed", "true");

      filterByTag(filter);
    });
  });
};

// Initialize when DOM is ready
const initProjects = () => {
  projectGrid = document.querySelector(".project-grid");
  renderProjects(filteredProjects);
  setupFilterEvents();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initProjects);
} else {
  initProjects();
}

const skillCards = skillArr.map((skill) => buildSkillCard(skill));
populateSkillGrid(skillCards);

document.querySelector(".download-resume").addEventListener("click", () => {
  window.open("./public/Merlin_Yang_Resume.pdf", "_blank");
});

animateSphere();
