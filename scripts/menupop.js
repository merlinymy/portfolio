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
