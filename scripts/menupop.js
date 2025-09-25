const menuBtn = document.querySelector(".menu-icon");
const closeBtn = document.querySelector(".close-icon");
const popupMenu = document.querySelector(".dropdown");
const html = document.querySelector("html");

function toggleMenu() {
  const isHidden = popupMenu.classList.contains("hidden");

  // Toggle visibility
  popupMenu.classList.toggle("hidden");
  html.classList.toggle("noscroll");

  // Update ARIA states
  menuBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");
  closeBtn.setAttribute("aria-expanded", isHidden ? "true" : "false");

  // Toggle button visibility
  menuBtn.classList.toggle("hidden");
  closeBtn.classList.toggle("hidden");

  // Focus management
  if (isHidden) {
    // Menu opened - focus first link
    const firstLink = popupMenu.querySelector("a");
    if (firstLink) firstLink.focus();
  } else {
    // Menu closed - return focus to menu button
    menuBtn.focus();
  }
}

// Menu button events
menuBtn.addEventListener("click", toggleMenu);
closeBtn.addEventListener("click", toggleMenu);

// Keyboard support for menu buttons
menuBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleMenu();
  }
});

closeBtn.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleMenu();
  }
});

// Close menu when clicking on menu items
const popupItems = document.querySelectorAll(".dropdown li");
popupItems.forEach((item) => {
  item.addEventListener("click", () => {
    if (!popupMenu.classList.contains("hidden")) {
      toggleMenu();
    }
  });
});

// Close menu on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !popupMenu.classList.contains("hidden")) {
    toggleMenu();
  }
});

// Close menu when clicking outside
document.addEventListener("click", (e) => {
  if (
    !popupMenu.classList.contains("hidden") &&
    !popupMenu.contains(e.target) &&
    !menuBtn.contains(e.target) &&
    !closeBtn.contains(e.target)
  ) {
    toggleMenu();
  }
});
