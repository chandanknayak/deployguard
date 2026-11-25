import React, { useMemo, useState } from "react";
import { Network } from "lucide-react";

const NODE_POSITIONS = {
  "subscription-billing": { x: 140, y: 90 },
  "order-service": { x: 430, y: 90 },
  "payment-service": { x: 285, y: 235 },
  "fraud-detection": { x: 690, y: 150 },
  "auth-gateway": { x: 690, y: 295 },
  "session-cache": { x: 430, y: 365 },
  "billing-ui": { x: 140, y: 355 },
};

function tierColor(tier) {
  if (tier === "P0") return { stroke: "#ef4444", fill: "#450a0a", badge: "text-red-300 border-red-500/40 bg-red-500/15" };
  if (tier === "P1") return { stroke: "#f59e0b", fill: "#451a03", badge: "text-amber-300 border-amber-500/40 bg-amber-500/15" };
  return { stroke: "#10b981", fill: "#022c22", badge: "text-emerald-300 border-emerald-500/40 bg-emerald-500/15" };
}

export default function ServiceGraphView({ graph, activeAssessment }) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const [selectedService, setSelectedService] = useState(
    activeAssessment?.originService || "payment-service"
  );

  const affectedSet = useMemo(
    () => new Set(activeAssessment?.affectedServices || []),
    [activeAssessment]
  );

  const selectedNode =
    nodes.find((n) => n.service === selectedService) || nodes[0] || null;

  const callers = edges.filter((e) => e.toService === selectedNode?.service);
  const dependencies = edges.filter((e) => e.fromService === selectedNode?.service);

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-indigo-400" />
              <h2 className="text-base font-bold text-white">
                AST-Extracted Microservice Dependency Graph
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              Built live from ES Module imports across {graph?.repository || "acme/payments-platform"}. Arrows point from caller to dependency.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="rounded border border-red-500/40 bg-red-500/15 px-2 py-0.5 text-red-300">P0 Critical</span>
            <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-amber-300">P1 High</span>
            <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-emerald-300">P2 Leaf</span>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3">
          <svg viewBox="0 0 840 430" className="w-full min-w-[640px] h-auto">
            <defs>
              <marker
                id="dg-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
              </marker>
              <marker
                id="dg-arrow-active"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1 L 10 5 L 0 9 z" fill="#818cf8" />
              </marker>
            </defs>

            {/* Edges */}
            {edges.map((edge, idx) => {
              const from = NODE_POSITIONS[edge.fromService] || { x: 100, y: 100 };
              const to = NODE_POSITIONS[edge.toService] || { x: 300, y: 200 };
              const isHighlighted =
                edge.fromService === selectedService || edge.toService === selectedService;
              const dx = to.x - from.x;
              const dy = to.y - from.y;
              const len = Math.hypot(dx, dy) || 1;
              const pad = 54;
              const x1 = from.x + (dx / len) * pad;
              const y1 = from.y + (dy / len) * 26;
              const x2 = to.x - (dx / len) * pad;
              const y2 = to.y - (dy / len) * 26;

              return (
                <g key={`${edge.fromService}-${edge.toService}-${idx}`}>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={isHighlighted ? "#818cf8" : "#334155"}
                    strokeWidth={isHighlighted ? 2.5 : 1.5}
                    markerEnd={isHighlighted ? "url(#dg-arrow-active)" : "url(#dg-arrow)"}
                  />
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node, i) => {
              const pos = NODE_POSITIONS[node.service] || { x: 120 + i * 95, y: 200 };
              const colors = tierColor(node.slaTier);
              const isSelected = node.service === selectedNode?.service;
              const inBlast = affectedSet.has(node.service);

              return (
                <g
                  key={node.service}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={() => setSelectedService(node.service)}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    x="-88"
                    y="-28"
                    width="176"
                    height="56"
                    rx="10"
                    fill={isSelected ? "#1e1b4b" : "#0f172a"}
                    stroke={isSelected ? "#818cf8" : inBlast ? colors.stroke : "#334155"}
                    strokeWidth={isSelected ? 2.5 : 1.5}
                  />
                  <text
                    x="0"
                    y="-4"
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize="12"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {node.service}
                  </text>
                  <text
                    x="0"
                    y="15"
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize="10"
                    fontFamily="Inter, sans-serif"
                  >
                    {node.slaTier} · {node.ownerTeam}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Right: Selected Service Inspector */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-4 space-y-4">
        {selectedNode ? (
          <>
            <div className="border-b border-slate-800 pb-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-bold font-mono text-white">
                  {selectedNode.service}
                </h3>
                <span
                  className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                    tierColor(selectedNode.slaTier).badge
                  }`}
                >
                  {selectedNode.slaTier}
                </span>
              </div>
              <p className="mt-1 text-xs font-mono text-slate-400">{selectedNode.filePath}</p>
              <p className="mt-1 text-xs text-slate-400">
                Owner: <span className="text-slate-200">{selectedNode.ownerTeam}</span> · On-call:{" "}
                <span className="text-slate-200">{selectedNode.onCall}</span>
              </p>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Exported AST Symbols ({selectedNode.exportedSymbols.length})
              </h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {selectedNode.exportedSymbols.map((sym) => (
                  <span
                    key={sym}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-xs font-mono text-indigo-300"
                  >
                    {sym}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Upstream Callers (Impacted if Modified) ({callers.length})
              </h4>
              {callers.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {callers.map((c, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedService(c.fromService)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-left hover:border-indigo-500/50 transition"
                    >
                      <p className="text-xs font-mono text-white">{c.fromService}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        imports: {c.importedSymbols.join(", ")}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-emerald-300">
                  Leaf service — zero upstream callers depend on this file.
                </p>
              )}
            </div>

            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Downstream Dependencies ({dependencies.length})
              </h4>
              {dependencies.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {dependencies.map((d, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedService(d.toService)}
                      className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-left hover:border-indigo-500/50 transition"
                    >
                      <p className="text-xs font-mono text-white">{d.toService}</p>
                      <p className="mt-0.5 text-[11px] text-slate-400">
                        calls: {d.importedSymbols.join(", ")}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-xs text-slate-400">No internal service imports.</p>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-400">Loading dependency graph...</p>
        )}
      </div>
    </section>
  );
}
