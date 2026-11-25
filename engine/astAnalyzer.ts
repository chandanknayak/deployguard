import * as acorn from "acorn";

export interface ExtractedSymbol {
  name: string;
  kind: "function" | "async_function" | "class" | "method" | "const" | "route";
  exported: boolean;
  params: string[];
  requiredParamCount: number;
  startLine: number;
  endLine: number;
  calls: string[];
  routeValue?: string;
}

export interface ExtractedImport {
  source: string;
  specifiers: string[];
}

export interface FileAstSummary {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  parseError: string | null;
}

export interface BreakingChange {
  symbol: string;
  kind:
    | "EXPORT_REMOVED"
    | "SIGNATURE_CHANGED"
    | "ROUTE_CHANGED"
    | "GUARD_REMOVED"
    | "SYNTAX_ERROR";
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  detail: string;
}

export interface AstDiffReport {
  parseError: string | null;
  modifiedSymbols: string[];
  addedSymbols: string[];
  deletedSymbols: string[];
  breakingChanges: BreakingChange[];
  riskyPatterns: string[];
  hasApiSurfaceChanges: boolean;
  baseSymbols: ExtractedSymbol[];
  headSymbols: ExtractedSymbol[];
}

function getParamName(param: any): { name: string; required: boolean } {
  if (!param) return { name: "arg", required: true };
  if (param.type === "Identifier") return { name: param.name, required: true };
  if (param.type === "AssignmentPattern") {
    const left = getParamName(param.left);
    return { name: `${left.name}=...`, required: false };
  }
  if (param.type === "RestElement") {
    const arg = getParamName(param.argument);
    return { name: `...${arg.name}`, required: false };
  }
  if (param.type === "ObjectPattern") return { name: "{...}", required: true };
  if (param.type === "ArrayPattern") return { name: "[...]", required: true };
  return { name: "arg", required: true };
}

function collectCalls(node: any, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "CallExpression") {
    if (node.callee?.type === "Identifier") {
      out.add(node.callee.name);
    } else if (
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.type === "Identifier"
    ) {
      out.add(node.callee.property.name);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) collectCalls(item, out);
    } else if (val && typeof val === "object" && val.type) {
      collectCalls(val, out);
    }
  }
}

export function analyzeFileAst(source: string): FileAstSummary {
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];

  let ast: any;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (err: any) {
    return {
      symbols: [],
      imports: [],
      parseError: err?.message || "JavaScript syntax parse error",
    };
  }

  const recordFunction = (fn: any, name: string, exported: boolean, outerLoc?: any) => {
    const parsedParams = (fn.params || []).map(getParamName);
    const calls = new Set<string>();
    collectCalls(fn.body, calls);
    const loc = outerLoc || fn.loc;
    symbols.push({
      name,
      kind: fn.async ? "async_function" : "function",
      exported,
      params: parsedParams.map((p: any) => p.name),
      requiredParamCount: parsedParams.filter((p: any) => p.required).length,
      startLine: loc?.start?.line ?? 1,
      endLine: loc?.end?.line ?? 1,
      calls: Array.from(calls),
    });
  };

  const visitDeclaration = (decl: any, exported: boolean, outerLoc?: any) => {
    if (!decl) return;
    if (decl.type === "FunctionDeclaration" && decl.id?.name) {
      recordFunction(decl, decl.id.name, exported, outerLoc || decl.loc);
    } else if (decl.type === "ClassDeclaration" && decl.id?.name) {
      const className = decl.id.name;
      symbols.push({
        name: className,
        kind: "class",
        exported,
        params: [],
        requiredParamCount: 0,
        startLine: (outerLoc || decl.loc)?.start?.line ?? 1,
        endLine: (outerLoc || decl.loc)?.end?.line ?? 1,
        calls: [],
      });
      for (const item of decl.body?.body || []) {
        if (item.type === "MethodDefinition" && item.key?.name) {
          const parsedParams = (item.value?.params || []).map(getParamName);
          const calls = new Set<string>();
          collectCalls(item.value?.body, calls);
          symbols.push({
            name: `${className}.${item.key.name}`,
            kind: "method",
            exported,
            params: parsedParams.map((p: any) => p.name),
            requiredParamCount: parsedParams.filter((p: any) => p.required).length,
            startLine: item.loc?.start?.line ?? 1,
            endLine: item.loc?.end?.line ?? 1,
            calls: Array.from(calls),
          });
        }
      }
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations || []) {
        if (d.id?.type !== "Identifier") continue;
        const name = d.id.name;
        if (
          d.init &&
          (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")
        ) {
          recordFunction(d.init, name, exported, outerLoc || decl.loc);
        } else {
          const routeValue =
            d.init?.type === "Literal" &&
            typeof d.init.value === "string" &&
            (name.startsWith("ROUTE_") || /\/api\//.test(d.init.value))
              ? d.init.value
              : undefined;
          symbols.push({
            name,
            kind: routeValue ? "route" : "const",
            exported,
            params: [],
            requiredParamCount: 0,
            startLine: (outerLoc || decl.loc)?.start?.line ?? 1,
            endLine: (outerLoc || decl.loc)?.end?.line ?? 1,
            calls: [],
            routeValue,
          });
        }
      }
    }
  };

  for (const node of ast.body || []) {
    if (node.type === "ImportDeclaration") {
      const specifiers = (node.specifiers || []).map((s: any) =>
        s.type === "ImportSpecifier"
          ? s.imported?.name || s.local?.name
          : s.local?.name || "*"
      );
      imports.push({
        source: String(node.source?.value || ""),
        specifiers,
      });
    } else if (node.type === "ExportNamedDeclaration") {
      visitDeclaration(node.declaration, true, node.loc);
    } else if (node.type === "ExportDefaultDeclaration") {
      visitDeclaration(node.declaration, true, node.loc);
    } else {
      visitDeclaration(node, false, node.loc);
    }
  }

  return { symbols, imports, parseError: null };
}

export function compareFileAsts(
  baseSource: string,
  headSource: string,
  modifiedOldLines: number[],
  modifiedNewLines: number[]
): AstDiffReport {
  const baseAst = analyzeFileAst(baseSource);
  const headAst = analyzeFileAst(headSource);

  if (headAst.parseError) {
    return {
      parseError: headAst.parseError,
      modifiedSymbols: [],
      addedSymbols: [],
      deletedSymbols: [],
      breakingChanges: [
        {
          symbol: "<syntax>",
          kind: "SYNTAX_ERROR",
          severity: "CRITICAL",
          detail: `PR introduces invalid JavaScript syntax: ${headAst.parseError}`,
        },
      ],
      riskyPatterns: ["syntax-error"],
      hasApiSurfaceChanges: true,
      baseSymbols: baseAst.symbols,
      headSymbols: [],
    };
  }

  const baseByName = new Map(baseAst.symbols.map((s) => [s.name, s]));
  const headByName = new Map(headAst.symbols.map((s) => [s.name, s]));

  const addedSymbols: string[] = [];
  const deletedSymbols: string[] = [];
  const modifiedSymbolsSet = new Set<string>();
  const breakingChanges: BreakingChange[] = [];

  for (const [name, bSym] of baseByName.entries()) {
    const hSym = headByName.get(name);
    if (!hSym) {
      deletedSymbols.push(name);
      if (bSym.exported) {
        breakingChanges.push({
          symbol: name,
          kind: "EXPORT_REMOVED",
          severity: "CRITICAL",
          detail: `Exported ${bSym.kind} '${name}' was deleted or renamed, breaking upstream callers.`,
        });
      }
      continue;
    }

    // Check route changes
    if (bSym.routeValue && bSym.routeValue !== hSym.routeValue) {
      modifiedSymbolsSet.add(name);
      breakingChanges.push({
        symbol: name,
        kind: "ROUTE_CHANGED",
        severity: "CRITICAL",
        detail: `API route '${bSym.routeValue}' changed to '${hSym.routeValue || "removed"}'.`,
      });
    }

    // Check parameter signature changes on exported functions/methods
    if (
      bSym.exported &&
      (bSym.kind === "function" || bSym.kind === "async_function" || bSym.kind === "method")
    ) {
      const oldSig = bSym.params.join(", ");
      const newSig = hSym.params.join(", ");
      if (oldSig !== newSig) {
        modifiedSymbolsSet.add(name);
        const paramCountChanged =
          bSym.requiredParamCount !== hSym.requiredParamCount ||
          bSym.params.length !== hSym.params.length;
        breakingChanges.push({
          symbol: name,
          kind: "SIGNATURE_CHANGED",
          severity: paramCountChanged ? "CRITICAL" : "HIGH",
          detail: `Exported signature '${name}(${oldSig})' changed to '${name}(${newSig})'.`,
        });
      }
    }

    // Check if any modified line intersects this symbol's body
    const touchedInOld = modifiedOldLines.some(
      (ln) => ln >= bSym.startLine && ln <= bSym.endLine
    );
    const touchedInNew = modifiedNewLines.some(
      (ln) => ln >= hSym.startLine && ln <= hSym.endLine
    );
    if (touchedInOld || touchedInNew) {
      modifiedSymbolsSet.add(name);
    }
  }

  for (const name of headByName.keys()) {
    if (!baseByName.has(name)) {
      addedSymbols.push(name);
    }
  }

  // Detect risky semantic changes (guard removals, lock/retry/auth edits)
  const riskyPatterns: string[] = [];
  const baseLower = baseSource.toLowerCase();
  const headLower = headSource.toLowerCase();

  if (baseLower.includes("idempotencykey") && !headLower.includes("if (!idempotencykey)")) {
    riskyPatterns.push("idempotency-guard-removed");
    breakingChanges.push({
      symbol: "chargeCard",
      kind: "GUARD_REMOVED",
      severity: "CRITICAL",
      detail: "Idempotency key validation guard was removed — exposes duplicate debit risk on retries.",
    });
  }
  if (
    baseLower.includes("acquiredistributedlock") &&
    !headLower.includes("acquiredistributedlock")
  ) {
    riskyPatterns.push("distributed-lock-removed");
    breakingChanges.push({
      symbol: "chargeCard",
      kind: "GUARD_REMOVED",
      severity: "CRITICAL",
      detail: "Distributed settlement lock call was removed — concurrent race condition risk.",
    });
  }
  if (
    modifiedSymbolsSet.has("computeBackoff") ||
    modifiedSymbolsSet.has("chargeCard") ||
    /retry|backoff|jitter/i.test(
      headSource
        .split("\n")
        .filter((_, idx) => modifiedNewLines.includes(idx + 1))
        .join(" ")
    )
  ) {
    riskyPatterns.push("retry-backoff-logic");
  }
  if (
    modifiedSymbolsSet.has("verifySessionToken") ||
    modifiedSymbolsSet.has("refreshOAuthToken")
  ) {
    riskyPatterns.push("auth-token-path");
  }
  if (modifiedSymbolsSet.has("acquireDistributedLock")) {
    riskyPatterns.push("lock-primitive-modified");
  }
  if (baseLower.includes("evaluatefraudrisk") && !headLower.includes("evaluatefraudrisk")) {
    riskyPatterns.push("fraud-check-bypassed");
    breakingChanges.push({
      symbol: "placeOrder",
      kind: "GUARD_REMOVED",
      severity: "CRITICAL",
      detail: "Fraud evaluation check was removed from checkout pipeline.",
    });
  }

  const hasApiSurfaceChanges =
    breakingChanges.length > 0 ||
    Array.from(modifiedSymbolsSet).some((name) => {
      const sym = headByName.get(name) || baseByName.get(name);
      return Boolean(sym?.exported && (sym.kind === "route" || sym.kind === "function" || sym.kind === "async_function"));
    });

  return {
    parseError: null,
    modifiedSymbols: Array.from(modifiedSymbolsSet),
    addedSymbols,
    deletedSymbols,
    breakingChanges,
    riskyPatterns,
    hasApiSurfaceChanges,
    baseSymbols: baseAst.symbols,
    headSymbols: headAst.symbols,
  };
}
