/**
 * Types mirroring the file formats consumed by GoogleChromeLabs/webmcp-tools'
 * `webmcp-evals` CLI, so that recordings can be exported without translation.
 */

export type EvalMessage =
  | { role: "user" | "model"; type: "message"; content: string }
  | { role: "model"; type: "functioncall"; name: string; arguments: object }
  | { role: "user"; type: "functionresponse"; name: string; response: object };

export interface EvalFunctionCall {
  functionName: string;
  arguments?: object | null;
  result?: unknown;
  mockOutput?: unknown;
  optional?: boolean;
}

export type ExpectedCallNode =
  | EvalFunctionCall
  | { unordered: ExpectedCallNode[] }
  | { ordered: ExpectedCallNode[] };

export interface EvalCase {
  name?: string;
  messages: EvalMessage[];
  expectedCall: ExpectedCallNode[] | null;
}

export interface EvalToolSchema {
  name: string;
  description: string;
  inputSchema: object | null;
  outputSchema: object | null;
}

export interface EvalToolsSchema {
  tools: EvalToolSchema[];
}
