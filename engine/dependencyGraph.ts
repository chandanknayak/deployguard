import fs from "node:fs";
import path from "node:path";
import { analyzeFileAst, type ExtractedSymbol } from "./astAnalyzer.ts";

export interface ServiceManifestEntry {
  service: string;
  slaTier: "P0" | "P1" | "P2";
  ownerTeam: string;
  onCall: string;
  criticalPath: boolean;
}

export interface ServiceGraphNode {
  filePath: string;
  service: string;
  slaTier: "P0" | "P1" | "P2";
  ownerTeam: string;
  onCall: string;
  criticalPath: boolean;
  exportedSymbols: string[];
  symbols: ExtractedSymbol[];
}

export interface ServiceGraphEdge {
  fromService: string;
  toService: string;
  fromFile: string;
  toFile: string;
  importedSymbols: string[];
}

export interface DependencyGraph {
  repository: string;
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
}

export interface ImpactedService {
  service: string;
  filePath: string;
  slaTier: "P0" | "P1" | "P2";
  ownerTeam: string;
  onCall: string;
  hops: number;
  viaSymbols: string[];
}

export interface BlastRadiusResult {
  originService: string;
  originSlaTier: "P0" | "P1" | "P2";
  maxDepthReached: number;
  totalAffected: number;
  hasP0Impact: boolean;
  hasP1Impact: boolean;
  affectedServices: string[];
  impactedDetails: ImpactedService[];
  traversedEdges: ServiceGraphEdge[];
}

export function buildDependencyGraphFromFiles(
  repository: string,
  manifestServices: Record<string, ServiceManifestEntry>,
  fileContents: Record<string, string>
): DependencyGraph {
  const nodes: ServiceGraphNode[] = [];
  const edges: ServiceGraphEdge[] = [];
  const fileToService = new Map<string, string>();

  for (const [filePath, meta] of Object.entries(manifestServices)) {
    fileToService.set(filePath, meta.service);
    const source = fileContents[filePath] || "";
    const ast = analyzeFileAst(source);
    nodes.push({
      filePath,
      service: meta.service,
      slaTier: meta.slaTier,
      ownerTeam: meta.ownerTeam,
      onCall: meta.onCall,
      criticalPath: meta.criticalPath,
      exportedSymbols: ast.symbols.filter((s) => s.exported).map((s) => s.name),
      symbols: ast.symbols,
    });
  }

  for (const [filePath, meta] of Object.entries(manifestServices)) {
    const source = fileContents[filePath] || "";
    const ast = analyzeFileAst(source);
    const dir = path.posix.dirname(filePath);
    for (const imp of ast.imports) {
      if (!imp.source.startsWith(".")) continue;
      const resolvedTarget = path.posix.normalize(path.posix.join(dir, imp.source));
      const targetService = fileToService.get(resolvedTarget);
      if (targetService) {
        // fromService depends on (calls) toService
        edges.push({
          fromService: meta.service,
          toService: targetService,
          fromFile: filePath,
          toFile: resolvedTarget,
          importedSymbols: imp.specifiers,
        });
      }
    }
  }

  return { repository, nodes, edges };
}

export function loadDemoRepoGraph(demoRepoDir: string): {
  graph: DependencyGraph;
  fileContents: Record<string, string>;
  manifest: { repository: string; defaultBranch: string; services: Record<string, ServiceManifestEntry> };
} {
  const manifestPath = path.resolve(demoRepoDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const fileContents: Record<string, string> = {};

  for (const relPath of Object.keys(manifest.services)) {
    const absPath = path.resolve(demoRepoDir, relPath);
    if (!absPath.startsWith(path.resolve(demoRepoDir) + path.sep)) {
      throw new Error(`Invalid manifest path outside demo-repo: ${relPath}`);
    }
    fileContents[relPath] = fs.readFileSync(absPath, "utf-8");
  }

  const graph = buildDependencyGraphFromFiles(
    manifest.repository,
    manifest.services,
    fileContents
  );
  return { graph, fileContents, manifest };
}

export function computeBlastRadius(
  graph: DependencyGraph,
  originFilePath: string,
  touchedSymbols: string[],
  maxDepth = 5
): BlastRadiusResult {
  const originNode = graph.nodes.find((n) => n.filePath === originFilePath);
  if (!originNode) {
    return {
      originService: originFilePath,
      originSlaTier: "P2",
      maxDepthReached: 0,
      totalAffected: 0,
      hasP0Impact: false,
      hasP1Impact: false,
      affectedServices: [originFilePath],
      impactedDetails: [],
      traversedEdges: [],
    };
  }

  const nodeByService = new Map(graph.nodes.map((n) => [n.service, n]));
  const visited = new Map<string, number>();
  visited.set(originNode.service, 0);

  const impactedDetails: ImpactedService[] = [];
  const traversedEdges: ServiceGraphEdge[] = [];
  const queue: Array<{ service: string; depth: number }> = [
    { service: originNode.service, depth: 0 },
  ];

  const touchedSet = new Set(touchedSymbols);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    // Find upstream callers: edges where toService === current.service
    const callerEdges = graph.edges.filter((e) => e.toService === current.service);

    for (const edge of callerEdges) {
      // At hop 0, if we know exact touched symbols, prioritize edges that import those symbols
      // (or include all callers if touchedSymbols is empty or syntax error)
      const directSymbolMatch =
        current.depth > 0 ||
        touchedSet.size === 0 ||
        edge.importedSymbols.some((sym) => touchedSet.has(sym));

      if (!directSymbolMatch) continue;

      traversedEdges.push(edge);
      const nextDepth = current.depth + 1;
      const callerNode = nodeByService.get(edge.fromService);
      if (!callerNode) continue;

      if (!visited.has(edge.fromService)) {
        visited.set(edge.fromService, nextDepth);
        impactedDetails.push({
          service: callerNode.service,
          filePath: callerNode.filePath,
          slaTier: callerNode.slaTier,
          ownerTeam: callerNode.ownerTeam,
          onCall: callerNode.onCall,
          hops: nextDepth,
          viaSymbols: edge.importedSymbols,
        });
        queue.push({ service: callerNode.service, depth: nextDepth });
      }
    }
  }

  impactedDetails.sort((a, b) => a.hops - b.hops || a.service.localeCompare(b.service));
  const maxDepthReached = impactedDetails.reduce((m, s) => Math.max(m, s.hops), 0);
  const allAffectedNodes = [originNode, ...impactedDetails];

  return {
    originService: originNode.service,
    originSlaTier: originNode.slaTier,
    maxDepthReached,
    totalAffected: impactedDetails.length,
    hasP0Impact:
      originNode.slaTier === "P0" || impactedDetails.some((s) => s.slaTier === "P0"),
    hasP1Impact:
      originNode.slaTier === "P1" || impactedDetails.some((s) => s.slaTier === "P1"),
    affectedServices: allAffectedNodes.map((s) => s.service),
    impactedDetails,
    traversedEdges,
  };
}
