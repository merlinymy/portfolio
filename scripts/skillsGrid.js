const buildSkillCard = (skillSet) => {
  const skillsCard = document.createElement("div");
  skillsCard.classList.add("skill-card");
  skillsCard.setAttribute("tabindex", "0");
  skillsCard.setAttribute("role", "region");
  skillsCard.setAttribute("aria-labelledby", `skill-title-${skillSet.group.replace(/\s+/g, '-').toLowerCase()}`);
  const cardTitle = document.createElement("h3");
  cardTitle.classList.add("card-title");
  cardTitle.textContent = skillSet.group;
  cardTitle.setAttribute("id", `skill-title-${skillSet.group.replace(/\s+/g, '-').toLowerCase()}`);
  const skCardsContainer = document.createElement("div");
  skCardsContainer.classList.add("sk-container");
  skillSet.skills.map((skill) => {
    const skCard = document.createElement("div");
    skCard.classList.add("sk-card");
    const icon = document.createElement("div");
    icon.classList.add("skill-icon");
    icon.innerHTML = skill.svg;
    const skillName = document.createElement("p");
    skillName.classList.add("skill-name");
    skillName.textContent = skill.name;
    skCard.append(icon, skillName);
    skCardsContainer.append(skCard);
  });
  skillsCard.append(cardTitle, skCardsContainer);
  return skillsCard;
};

const populateSkillGrid = (skillSets) => {
  const skillSection = document.querySelector(".skill-grid");
  skillSection.append(...skillSets);
};

export { buildSkillCard, populateSkillGrid };
