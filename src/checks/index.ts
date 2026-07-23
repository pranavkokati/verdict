import type { CheckModule } from "../types.js";
import { contrastCheck } from "./contrast.js";
import { typeScaleCheck } from "./typeScale.js";
import { spacingGridCheck } from "./spacingGrid.js";
import { hierarchyCheck } from "./hierarchy.js";

export const ALL_CHECKS: CheckModule[] = [
  contrastCheck,
  typeScaleCheck,
  spacingGridCheck,
  hierarchyCheck,
];

export { contrastCheck, typeScaleCheck, spacingGridCheck, hierarchyCheck };
