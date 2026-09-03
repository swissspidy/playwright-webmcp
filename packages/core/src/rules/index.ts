import type { Rule } from "../types.js";
import toolNameValid from "./tool-name-valid.js";
import { descriptionLength, descriptionMissing, paramDescriptionMissing } from "./description-quality.js";
import { schemaDepth, schemaKeywords, schemaNulls, schemaShape, sensitiveParams } from "./schema.js";
import { duplicateToolName, iframeAllowTools, noTools, similarDescriptions, tooManyTools } from "./page.js";
import { declarativeAutosubmit, declarativeDescription, declarativeFieldLabels } from "./declarative.js";
import { descriptionInjection } from "./injection.js";
import { exposedToInsecure, namingConsistency } from "./naming.js";

export const builtinRules: Rule[] = [
  toolNameValid,
  descriptionMissing,
  descriptionLength,
  paramDescriptionMissing,
  schemaShape,
  schemaNulls,
  schemaDepth,
  schemaKeywords,
  sensitiveParams,
  duplicateToolName,
  similarDescriptions,
  tooManyTools,
  noTools,
  iframeAllowTools,
  declarativeDescription,
  declarativeFieldLabels,
  declarativeAutosubmit,
  descriptionInjection,
  namingConsistency,
  exposedToInsecure,
];

export const rulesById: Record<string, Rule> = Object.fromEntries(builtinRules.map((r) => [r.id, r]));
