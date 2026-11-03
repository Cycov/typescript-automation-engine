/**
 * Minimal unified diff for approval previews (line based, LCS).
 */

const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_CELLS = 4_000_000; //< above this the middle part is shown as a full replace

type DiffOp = { kind: " " | "-" | "+"; text: string };

function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  let prefixLength = 0;
  while (
    prefixLength < oldLines.length &&
    prefixLength < newLines.length &&
    oldLines[prefixLength] === newLines[prefixLength]
  ) {
    prefixLength++;
  }
  let suffixLength = 0;
  while (
    suffixLength < oldLines.length - prefixLength &&
    suffixLength < newLines.length - prefixLength &&
    oldLines[oldLines.length - 1 - suffixLength] === newLines[newLines.length - 1 - suffixLength]
  ) {
    suffixLength++;
  }

  const oldMiddle = oldLines.slice(prefixLength, oldLines.length - suffixLength);
  const newMiddle = newLines.slice(prefixLength, newLines.length - suffixLength);
  const ops: DiffOp[] = oldLines.slice(0, prefixLength).map((text) => ({ kind: " ", text }));

  if (oldMiddle.length * newMiddle.length > DIFF_MAX_CELLS) {
    for (const text of oldMiddle) ops.push({ kind: "-", text });
    for (const text of newMiddle) ops.push({ kind: "+", text });
  } else {
    // lcs[iOld][iNew] = LCS length of oldMiddle[iOld..] and newMiddle[iNew..]
    const width = newMiddle.length + 1;
    const lcs = new Uint32Array((oldMiddle.length + 1) * width);
    for (let iOld = oldMiddle.length - 1; iOld >= 0; iOld--) {
      for (let iNew = newMiddle.length - 1; iNew >= 0; iNew--) {
        lcs[iOld * width + iNew] =
          oldMiddle[iOld] === newMiddle[iNew]
            ? lcs[(iOld + 1) * width + iNew + 1] + 1
            : Math.max(lcs[(iOld + 1) * width + iNew], lcs[iOld * width + iNew + 1]);
      }
    }
    let iOld = 0;
    let iNew = 0;
    while (iOld < oldMiddle.length && iNew < newMiddle.length) {
      if (oldMiddle[iOld] === newMiddle[iNew]) {
        ops.push({ kind: " ", text: oldMiddle[iOld] });
        iOld++;
        iNew++;
      } else if (lcs[(iOld + 1) * width + iNew] >= lcs[iOld * width + iNew + 1]) {
        ops.push({ kind: "-", text: oldMiddle[iOld] });
        iOld++;
      } else {
        ops.push({ kind: "+", text: newMiddle[iNew] });
        iNew++;
      }
    }
    for (; iOld < oldMiddle.length; iOld++) ops.push({ kind: "-", text: oldMiddle[iOld] });
    for (; iNew < newMiddle.length; iNew++) ops.push({ kind: "+", text: newMiddle[iNew] });
  }

  for (const text of oldLines.slice(oldLines.length - suffixLength)) ops.push({ kind: " ", text });
  return ops;
}

/** Unified diff of two texts; empty string when they are equal. */
export function unifiedDiff(oldText: string, newText: string, label: string): string {
  const ops = diffLines(oldText.split(/\r?\n/), newText.split(/\r?\n/));
  const changed = ops.map((op, iOp) => (op.kind !== " " ? iOp : -1)).filter((iOp) => iOp >= 0);
  if (changed.length === 0) return "";

  const output: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let iChanged = 0;
  while (iChanged < changed.length) {
    const hunkStart = Math.max(0, changed[iChanged] - DIFF_CONTEXT_LINES);
    let hunkEnd = Math.min(ops.length - 1, changed[iChanged] + DIFF_CONTEXT_LINES);
    // Merge following changes whose context overlaps
    while (iChanged + 1 < changed.length && changed[iChanged + 1] - DIFF_CONTEXT_LINES <= hunkEnd + 1) {
      iChanged++;
      hunkEnd = Math.min(ops.length - 1, changed[iChanged] + DIFF_CONTEXT_LINES);
    }
    iChanged++;

    let oldLine = 1;
    let newLine = 1;
    for (let iOp = 0; iOp < hunkStart; iOp++) {
      if (ops[iOp].kind !== "+") oldLine++;
      if (ops[iOp].kind !== "-") newLine++;
    }
    const hunk = ops.slice(hunkStart, hunkEnd + 1);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    output.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (const op of hunk) output.push(op.kind + op.text);
  }
  return output.join("\n");
}
