/**
 * Turns the page's six profile sections into pop-up panels (plan §4.2). Without JavaScript the
 * sections stay ordinary parts of the page and the nav links jump to them, so crawlers and no-JS
 * visitors read a plain portfolio.
 *
 * Each section moves into a <dialog>, the browser's built-in pop-up: it moves keyboard focus into
 * the panel, closes on Esc and is announced properly by screen readers. The address keeps the
 * open panel's #id, so a link like merlinyang.com/#projects opens that panel and Back closes it.
 */
import { PANELS } from "../lib/panels";
import { control } from "./face/settings";

/** Below this width panels fill the screen; above it they slide in from the right. */
const SHEET_MEDIA = "(min-width: 900px)";

export function setupPanels(): () => void {
  const dialogs = new Map<string, HTMLDialogElement>();
  const homes = new Map<string, { parent: Node; next: Node | null }>();
  let opener: HTMLElement | null = null;

  for (const { id } of PANELS) {
    const section = document.getElementById(id);
    if (!section?.parentNode) continue;
    homes.set(id, { parent: section.parentNode, next: section.nextSibling });

    const dialog = document.createElement("dialog");
    dialog.className = "panel-dialog";
    dialog.setAttribute("aria-labelledby", `${id}-title`);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "panel-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    const body = document.createElement("div");
    body.className = "panel-body";
    body.append(section);
    dialog.append(close, body);
    // A click on the dimmed area outside the panel lands on the dialog itself.
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => closed(id));
    document.body.append(dialog);
    dialogs.set(id, dialog);
  }
  document.documentElement.classList.add("js-panels");

  function open(dialog: HTMLDialogElement) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector(".panel-body")?.scrollTo(0, 0);
    const sheet = matchMedia(SHEET_MEDIA).matches;
    const inset = sheet ? dialog.getBoundingClientRect().width : 0;
    // The face moves into the space left of the sheet and glances toward it.
    control.panelInset = inset;
    control.attention = sheet ? { x: innerWidth - inset, y: innerHeight * 0.45 } : null;
    if (control.state === "idle" || control.state === "listening") control.setState("panel");
  }

  function closed(id: string) {
    if (location.hash === `#${id}`) history.replaceState(null, "", location.pathname + location.search);
    // The close event arrives a moment late, so when one panel replaced another, leave the new one be.
    if ([...dialogs.values()].some((d) => d.open)) return;
    control.panelInset = 0;
    control.attention = null;
    if (control.state === "panel") control.setState("idle");
    opener?.focus({ preventScroll: true });
    opener = null;
  }

  // The address decides which panel is open, so links, Back and Forward all work the same way.
  function sync() {
    const target = dialogs.get(decodeURIComponent(location.hash.slice(1)));
    for (const dialog of dialogs.values()) if (dialog !== target && dialog.open) dialog.close();
    if (target && !target.open) open(target);
  }
  window.addEventListener("hashchange", sync);
  sync();

  // The pointer already steers the face onto a hovered button; keyboard focus does the same.
  const links = [...document.querySelectorAll<HTMLElement>(".profile-nav a")];
  const onFocus = (e: FocusEvent) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches(":focus-visible")) return;
    const box = e.target.getBoundingClientRect();
    control.attention = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const onBlur = () => {
    if (![...dialogs.values()].some((d) => d.open)) control.attention = null;
  };
  for (const link of links) {
    link.addEventListener("focus", onFocus);
    link.addEventListener("blur", onBlur);
  }

  return () => {
    window.removeEventListener("hashchange", sync);
    for (const link of links) {
      link.removeEventListener("focus", onFocus);
      link.removeEventListener("blur", onBlur);
    }
    document.documentElement.classList.remove("js-panels");
    for (const [id, dialog] of dialogs) {
      const section = document.getElementById(id);
      const home = homes.get(id);
      if (section && home) home.parent.insertBefore(section, home.next);
      dialog.remove();
    }
  };
}
