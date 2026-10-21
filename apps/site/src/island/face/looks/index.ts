/**
 * The face's looks (docs/face-looks-plan.md). "scan", the points and edges, is drawn by Face.tsx
 * itself; every other look is built here when chosen and thrown away when another is.
 */
import type { Look, LookParts } from "./common";
import { createFlame } from "./flame";
import { createInk } from "./ink";
import type { LookStyle } from "./params";

export type { Look, LookFrame } from "./common";

const BUILDERS: Record<Exclude<LookStyle, "scan">, (parts: LookParts) => Look> = {
  flame: createFlame,
  ink: createInk,
};

export function createLook(style: LookStyle, parts: LookParts): Look | undefined {
  return style === "scan" ? undefined : BUILDERS[style](parts);
}
