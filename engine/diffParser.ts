export interface DiffLine {
  type: "context" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface ComputedDiff {
  filename: string;
  addedCount: number;
  removedCount: number;
  modifiedOldLines: number[];
  modifiedNewLines: number[];
  lines: DiffLine[];
  unifiedText: string;
}

export interface ParsedExternalFileDiff {
  filename: string;
  addedCount: number;
  removedCount: number;
  addedLinesText: string[];
  removedLinesText: string[];
}

export function computeUnifiedDiff(
  oldContent: string,
  newContent: string,
  filename: string
): ComputedDiff {
  const oldLines = oldContent.replace(/\r\n/g, "\n").split("\n");
  const newLines = newContent.replace(/\r\n/g, "\n").split("\n");
  const m = oldLines.length;
  const n = newLines.length;

  // Standard LCS dynamic programming table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const lines: DiffLine[] = [];
  const modifiedOldLines: number[] = [];
  const modifiedNewLines: number[] = [];
  let addedCount = 0;
  let removedCount = 0;

  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ type: "context", oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "del", oldLine: i + 1, newLine: null, text: oldLines[i] });
      modifiedOldLines.push(i + 1);
      removedCount++;
      i++;
    } else {
      lines.push({ type: "add", oldLine: null, newLine: j + 1, text: newLines[j] });
      modifiedNewLines.push(j + 1);
      addedCount++;
      j++;
    }
  }
  while (i < m) {
    lines.push({ type: "del", oldLine: i + 1, newLine: null, text: oldLines[i] });
    modifiedOldLines.push(i + 1);
    removedCount++;
    i++;
  }
  while (j < n) {
    lines.push({ type: "add", oldLine: null, newLine: j + 1, text: newLines[j] });
    modifiedNewLines.push(j + 1);
    addedCount++;
    j++;
  }

  const unifiedHeader = [`--- a/${filename}`, `+++ b/${filename}`];
  const unifiedBody = lines
    .filter((l, idx) => {
      if (l.type !== "context") return true;
      // Include up to 2 context lines around any change
      for (let k = Math.max(0, idx - 2); k <= Math.min(lines.length - 1, idx + 2); k++) {
        if (lines[k].type !== "context") return true;
      }
      return false;
    })
    .map((l) => `${l.type === "add" ? "+" : l.type === "del" ? "-" : " "}${l.text}`);

  const unifiedText =
    addedCount === 0 && removedCount === 0
      ? ""
      : [...unifiedHeader, ...unifiedBody].join("\n");

  return {
    filename,
    addedCount,
    removedCount,
    modifiedOldLines,
    modifiedNewLines,
    lines,
    unifiedText,
  };
}

export function parseExternalUnifiedDiff(rawDiff: string): ParsedExternalFileDiff[] {
  const files: ParsedExternalFileDiff[] = [];
  let current: ParsedExternalFileDiff | null = null;

  for (const line of rawDiff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/b\/(.+)$/);
      current = {
        filename: match ? match[1] : "unknown",
        addedCount: 0,
        removedCount: 0,
        addedLinesText: [],
        removedLinesText: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++ b/")) {
      current.filename = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedCount++;
      current.addedLinesText.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.removedCount++;
      current.removedLinesText.push(line.slice(1));
    }
  }

  return files;
}
