import tcg from "../assets/projectImg/tcg.png";
import smgen from "../assets/projectImg/smgen.png";
import fireproofsheep from "../assets/projectImg/fireproofship.png";
import rainbowSphere from "../assets/projectImg/rainbowSphere.png";
import resumeBuilder from "../assets/projectImg/resumeBuilder.png";
import binaryTree from "../assets/projectImg/binaryTree.png";
import bubble from "../assets/projectImg/bubble.png";
import weatherapp from "../assets/projectImg/weatherapp.png";
import todo from "../assets/projectImg/todo.png";

export const projectArr = [
  {
    imgUrl: tcg,
    name: "Pokemon TCG Memory League",
    desc: "A collectible twist on the classic memory game, featuring Pokémon TCG cards and progressive challenges.",
    tech: ["React", "Tailwind", "Howler.js", "Vite"],
    links: [
      "https://github.com/merlinymy/tcg-memo-collector",
      "https://tcgmemoryleague.merlinyang.com/",
    ],
  },
  {
    imgUrl: smgen,
    name: "Social Media Post Generator",
    desc: "An AI-powered social media post generator with multilingual support, business info management, and a personalized dashboard.",
    tech: ["React", "Tailwind", "Supabase", "Cursor"],
    links: ["https://fantastmediagen.vercel.app/login"],
  },
  {
    imgUrl: fireproofsheep,
    name: "Fireproof Sheep",
    desc: "A top-down shooter web game built with PixiJS. With a unique wool-based resource system that powers both offense and defense.",
    tech: ["Pixi.js", "Claude Agent"],
    links: ["https://fire-proof-sheep.vercel.app/"],
  },
  {
    imgUrl: rainbowSphere,
    name: "Giant Interactive 3D Sphere",
    desc: "A dynamic, layered triangle turning into a sphere visualized in the browser that blends geometry, animation, and interaction.",
    tech: ["Three.js"],
    links: [
      "https://github.com/merlinymy/layered-triangle-sphere",
      "https://layered-triangle-sphere.vercel.app/",
    ],
  },
  {
    imgUrl: resumeBuilder,
    name: "ATS Friendly Resume Builder",
    desc: "A modern, printable, and ATS-safe resume builder built with React.",
    tech: ["React", "Tailwind"],
    links: [
      "https://github.com/merlinymy/cv-builder",
      "https://atsresume.merlinyang.com/",
    ],
  },
  {
    imgUrl: binaryTree,
    name: "Binary Tree Visualizer",
    desc: "A retro-styled browser app to visualize, edit, and explore binary search trees in real time.",
    tech: ["Javascript", "css", "html"],
    links: [
      "https://github.com/merlinymy/binary-search-tree-visualizer",
      "https://merlinymy.github.io/binary-search-tree-visualizer/",
    ],
  },
  {
    imgUrl: bubble,
    name: "Bubble Bar Restaurant Page",
    desc: "Bubble Bar is a fictional restaurant website featuring a Star Trek-inspired menu and a custom bubble rising animation created with HTML Canvas. ",
    tech: ["Javascript", "css", "html", "canvas"],
    links: [
      "https://github.com/merlinymy/bubbleBar",
      "https://merlinymy.github.io/bubbleBar/",
    ],
  },
  {
    imgUrl: weatherapp,
    name: "iOS-styled Weather App",
    desc: "A web replica of Apple’s Weather app focused on a clean, responsive iOS-style UI.",
    tech: ["Javascript", "css", "html"],
    links: [
      "https://github.com/merlinymy/apple-weather-app-replica",
      "https://merlinymy.github.io/apple-weather-app-replica/",
    ],
  },
  {
    imgUrl: todo,
    name: "iOS-styled Todo List",
    desc: "A lightweight, iOS-inspired reminder app, built entirely with JavaScript, CSS, and HTML—no frameworks, no libraries. This project is a testament to my capability of crafting a smooth, iOS-like experience using only vanilla web technologies.",
    tech: ["Javascript", "css", "html"],
    links: [
      "https://github.com/merlinymy/ios-reminder-copy",
      "https://merlinymy.github.io/ios-reminder-copy/",
    ],
  },
];
