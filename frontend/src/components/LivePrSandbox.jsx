import React, { useEffect, useState } from "react";
import {
  FileCode2,
  GitPullRequest,
  Github,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";

function slaBadge(tier) {
  if (tier === "P0") return "bg-red-500/15 text-red-300 border-red-500/40";
  if (tier === "P1") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
}

function gateBadge(gate) {
  if (gate === "BLOCK") return "bg-red-500/15 text-red-300 border-red-500/40";
  if (gate === "WARN") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
}

export default function LivePrSandbox({
  sandboxData,
  onSubmitSandboxPr,
  onAnalyzeGitHubPr,
  onResetSandbox,
}) {
  const files = sandboxData?.files || [];
  const scenarios = sandboxData?.scenarios || [];

  const [selectedFilePath, setSelectedFilePath] = useState(
    files[0]?.filePath || "services/payment_service.js"
  );
  const [editorCode, setEditorCode] = useState(files[0]?.content || "");
  const [prTitle, setPrTitle] = useState("");
  const [author, setAuthor] = useState("s.engineer");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Optional Real Public GitHub PR Analyzer
  const [ghRepo, setGhRepo] = useState("expressjs/express");
  const [ghPrNumber, setGhPrNumber] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState("");

  const currentFile = files.find((f) => f.filePath === selectedFilePath) || files[0];

  useEffect(() => {
    if (currentFile && !editorCode) {
      setSelectedFilePath(currentFile.filePath);
      setEditorCode(currentFile.content);
    }
  }, [currentFile, editorCode]);

  function handleSelectFile(file) {
    setSelectedFilePath(file.filePath);
    setEditorCode(file.content);
    setPrTitle(`Update ${file.service} (${file.filePath.split("/").pop()})`);
    setErrorMsg("");
  }

  function handleLoadScenario(scenario) {
    setSelectedFilePath(scenario.filePath);
    setEditorCode(scenario.modifiedCode);
    setPrTitle(scenario.prTitle);
    setErrorMsg("");
  }

  function handleRevertEditor() {
    if (currentFile) {
      setEditorCode(currentFile.content);
      setErrorMsg("");
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErrorMsg("");
    if (!prTitle.trim()) {
      setErrorMsg("Enter a Pull Request title before running DeployGuard.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await onSubmitSandboxPr({
        filePath: selectedFilePath,
        modifiedCode: editorCode,
        prTitle: prTitle.trim(),
        author: author.trim() || "engineer",
      });
      if (!res.ok) {
        setErrorMsg(res.error || "Failed to analyze pull request.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGitHubSubmit(e) {
    e.preventDefault();
    setGhError("");
    const num = Number(ghPrNumber);
    if (!ghRepo.trim() || !Number.isInteger(num) || num <= 0) {
      setGhError("Enter a public GitHub repo (owner/repo) and a positive PR number.");
      return;
    }
    setGhBusy(true);
    try {
      const res = await onAnalyzeGitHubPr({ repo: ghRepo.trim(), prNumber: num });
      if (!res.ok) {
        setGhError(res.error || "Could not analyze GitHub PR.");
      }
    } finally {
      setGhBusy(false);
    }
  }

  const hasChanges =
    currentFile &&
    currentFile.content.replace(/\r\n/g, "\n") !== editorCode.replace(/\r\n/g, "\n");

  return (
    <div className="space-y-6">
      {/* Top 1-Click Test Scenarios Strip */}
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-400" />
              <h2 className="text-base font-bold text-white">
                Live Demo Repo PR Sandbox ({sandboxData?.repository || "acme/payments-platform"})
              </h2>
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              Edit any service file below — or load a real tamper scenario — and open a Pull Request to watch DeployGuard parse the real AST, trace multi-hop blast radius, and enforce the CI/CD gate.
            </p>
          </div>
          <button
            type="button"
            onClick={onResetSandbox}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-600 hover:text-white transition"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>Reset Demo Repo</span>
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          {scenarios.map((sc) => (
            <button
              key={sc.id}
              type="button"
              onClick={() => handleLoadScenario(sc)}
              className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-left hover:border-indigo-500/60 transition"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-white">{sc.label}</span>
                <span
                  className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${gateBadge(
                    sc.expectedGate
                  )}`}
                >
                  {sc.expectedGate}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                {sc.description}
              </p>
            </button>
          ))}
        </div>
      </section>

      {/* Main Sandbox Editor Grid */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left: Demo Repo File Explorer + Real GitHub PR Scanner */}
        <div className="space-y-6 lg:col-span-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-white">
              Repository Services ({files.length} files)
            </h3>
            <div className="space-y-2">
              {files.map((file) => {
                const isSelected = file.filePath === selectedFilePath;
                return (
                  <button
                    key={file.filePath}
                    type="button"
                    onClick={() => handleSelectFile(file)}
                    className={`w-full rounded-lg border p-2.5 text-left transition ${
                      isSelected
                        ? "border-indigo-500 bg-slate-800/90"
                        : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-200">
                        <FileCode2 className="h-3.5 w-3.5 text-indigo-400" />
                        {file.filePath.replace("services/", "")}
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${slaBadge(
                          file.slaTier
                        )}`}
                      >
                        {file.slaTier}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400 truncate">
                      {file.service} · exports: {file.exportedSymbols.join(", ")}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Scan Any Real Public GitHub PR */}
          <form
            onSubmit={handleGitHubSubmit}
            className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3"
          >
            <div className="flex items-center gap-2">
              <Github className="h-4 w-4 text-slate-200" />
              <h3 className="text-sm font-semibold text-white">
                Scan Any Public GitHub PR
              </h3>
            </div>
            <p className="text-xs text-slate-400">
              Fetch a real GitHub pull request diff directly and run DeployGuard risk scoring.
            </p>
            <div className="space-y-2">
              <label className="block text-xs text-slate-300">
                Repository (owner/repo)
                <input
                  type="text"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="e.g. expressjs/express"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </label>
              <label className="block text-xs text-slate-300">
                Pull Request #
                <input
                  type="number"
                  min="1"
                  value={ghPrNumber}
                  onChange={(e) => setGhPrNumber(e.target.value)}
                  placeholder="e.g. 5900"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-mono text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>
            {ghError && <p className="text-xs text-red-400">{ghError}</p>}
            <button
              type="submit"
              disabled={ghBusy}
              className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50 transition"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{ghBusy ? "Fetching GitHub Diff..." : "Analyze Live GitHub PR"}</span>
            </button>
          </form>
        </div>

        {/* Right: Real Code Editor + Open Pull Request Form */}
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-8 flex flex-col space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div>
              <p className="text-xs font-mono text-indigo-300">
                {selectedFilePath} · {currentFile?.service} ({currentFile?.slaTier})
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Owner: {currentFile?.ownerTeam} · On-call: {currentFile?.onCall}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasChanges ? (
                <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                  Modified
                </span>
              ) : (
                <span className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-[11px] text-slate-400">
                  Clean (main)
                </span>
              )}
              <button
                type="button"
                onClick={handleRevertEditor}
                disabled={!hasChanges}
                className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-300 hover:text-white disabled:opacity-40"
              >
                Revert File
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="sm:col-span-2 text-xs text-slate-300">
              Pull Request Title
              <input
                type="text"
                value={prTitle}
                onChange={(e) => setPrTitle(e.target.value)}
                placeholder="Describe your code change..."
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <label className="text-xs text-slate-300">
              Author
              <input
                type="text"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="engineer"
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="flex-1 flex flex-col text-xs text-slate-300">
            <span className="mb-1.5">
              Source Code (try removing a parameter, deleting a guard, or editing formatting)
            </span>
            <textarea
              value={editorCode}
              onChange={(e) => setEditorCode(e.target.value)}
              spellCheck={false}
              rows={17}
              className="w-full flex-1 rounded-lg border border-slate-700 bg-slate-950 p-3.5 font-mono text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
          </label>

          {errorMsg && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {errorMsg}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-xs text-slate-400">
              Runs deterministic Acorn AST diff + multi-hop blast radius + incident recall
            </p>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
            >
              <GitPullRequest className="h-4 w-4" />
              <span>
                {submitting ? "Running DeployGuard AST Engine..." : "Submit PR & Run DeployGuard"}
              </span>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
