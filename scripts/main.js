import { animateSphere } from "./floating.js";

animateSphere();
const menuBtn = document.querySelector(".menu-icon");
const popupMenu = document.querySelector(".dropdown");
menuBtn.addEventListener("click", () => {
  popupMenu.classList.toggle("hidden");
});
