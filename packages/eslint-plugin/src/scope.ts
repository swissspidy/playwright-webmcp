/**
 * Scope lookups the rules share. Only `sourceCode.getScope` is used, so they
 * also work in oxlint's JS plugin runner.
 */
import type { Rule as ESLintRule, Scope } from "eslint";
import type * as ESTree from "estree";

export type SourceCode = ESLintRule.RuleContext["sourceCode"];

/** The variable an identifier refers to, from the nearest scope that declares the name; undefined for a global. */
export function findVariable(identifier: ESTree.Identifier, sourceCode: SourceCode): Scope.Variable | undefined {
  let scope: Scope.Scope | null;
  try {
    scope = sourceCode.getScope(identifier);
  } catch {
    return undefined;
  }
  for (; scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return undefined;
}
