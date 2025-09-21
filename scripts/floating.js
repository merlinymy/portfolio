import * as THREE from "three";

const animateSphere = () => {
  const canvas = document.querySelector(".webgl");
  const landingSection = document.querySelector("main");
  const canvasSize = {
    width: landingSection.getBoundingClientRect().width,
    height: landingSection.getBoundingClientRect().height,
  };
  const scene = new THREE.Scene();
  scene.background = new THREE.Color().set("#0b0d10");
  const cam = new THREE.PerspectiveCamera(
    75,
    canvasSize.width / canvasSize.height,
    1,
    1000
  );
  cam.position.set(0, 0, 50);
  scene.add(cam);

  const renderer = new THREE.WebGLRenderer({ canvas });
  renderer.setSize(canvasSize.width, canvasSize.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  window.addEventListener("resize", () => {
    canvasSize.width = landingSection.getBoundingClientRect().width;
    canvasSize.height = landingSection.getBoundingClientRect().height;
    cam.aspect = canvasSize.width / canvasSize.height;
    cam.updateProjectionMatrix();
    renderer.setSize(canvasSize.width, canvasSize.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  });

  const geometry = new THREE.TorusKnotGeometry(9, 1.2, 32, 16, 10, 5);
  const material = new THREE.MeshStandardMaterial({
    color: "#f3f3f3",
    metalness: 1,
    roughness: 0.12,
  });

  const torusKnot = new THREE.Mesh(geometry, material);

  torusKnot.position.set(0, 10, 0);
  scene.add(torusKnot);

  const light = new THREE.PointLight("rgba(209, 209, 252, 1)", 10);
  light.position.set(0, 0, 0);
  scene.add(light);

  const directionalLight = new THREE.DirectionalLight(
    "rgba(191, 243, 255)",
    20
  );
  directionalLight.position.set(0, 0, 20);
  scene.add(directionalLight);

  const clock = new THREE.Clock();
  const tick = () => {
    const delta = clock.getDelta();
    renderer.render(scene, cam);
    torusKnot.rotateX(delta * 0.1);
    torusKnot.rotateY(delta * 0.1);
    torusKnot.rotateZ(delta * 0.25);

    window.requestAnimationFrame(tick);
  };
  tick();

  let lastScrollY = window.scrollY;

  window.addEventListener("scroll", function () {
    const currentScrollY = window.scrollY;
    lastScrollY = currentScrollY;
    cam.position.set(0, lastScrollY * -0.01, 50);
  });
};

export { animateSphere };
