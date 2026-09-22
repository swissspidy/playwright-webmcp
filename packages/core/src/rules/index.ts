import type { Rule } from "../types.js";
import toolNameValid from "./tool-name-valid.js";
import { descriptionLength, descriptionMissing, paramDescriptionMissing } from "./description-quality.js";
import { schemaDepth, schemaKeywords, schemaNulls, schemaShape, sensitiveParams } from "./schema.js";
import { duplicateToolName, noTools, similarDescriptions, tooManyTools } from "./page.js";
import { declarativeAutosubmit, declarativeDescription, declarativeFieldLabels } from "./declarative.js";
import { descriptionInjection } from "./injection.js";
import { namingConsistency } from "./naming.js";
import { exposedToInsecure } from "./exposure.js";
import { capabilityTrifecta } from "./capability.js";
import { thirdPartyRegistration, toolShadowing } from "./shadowing.js";
import { annotationsExplicit, annotationsValid, descriptionPlaceholder, exposedToOriginOnly, toolNameStyle, toolTitleMissing } from "./quality.js";

export const builtinRules: Rule[] = [
  toolNameValid,
  toolNameStyle,
  toolTitleMissing,
  descriptionMissing,
  descriptionPlaceholder,
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
  declarativeDescription,
  declarativeFieldLabels,
  declarativeAutosubmit,
  descriptionInjection,
  namingConsistency,
  exposedToInsecure,
  exposedToOriginOnly,
  annotationsValid,
  annotationsExplicit,
  capabilityTrifecta,
  toolShadowing,
  thirdPartyRegistration,
];

export const rulesById: Record<string, Rule> = Object.fromEntries(builtinRules.map((r) => [r.id, r]));
