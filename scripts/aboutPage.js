document.querySelector(".download-resume").addEventListener("click", () => {
  window.open("/Merlin_Yang_Resume.pdf", "_blank");
});

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

const sections = document.querySelectorAll("section");
console.log(sections);
sections.forEach((card) => projectObserver.observe(card));
