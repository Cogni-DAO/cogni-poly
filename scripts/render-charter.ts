// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/render-charter`
 * Purpose: Render the LLM-owned charter at `work/charters/POLY_COPY_DELTA.md`
 *   to a viewable `research/delta-minimizing/charter.html`. One-shot,
 *   manual: invoked by hand after editing the .md, NEVER from another
 *   script. Pure markdown → HTML over the .md the LLM just authored.
 * Scope: Reads one .md and writes one .html. Does not scan other files,
 *   query a DB, or aggregate tallies from past investigations.
 * Invariants: NO_AUTO_CONTENT — the renderer never invents tallies,
 *   summaries, or aggregates from other files. The .md is the only
 *   source of truth; the .html is a viewable mirror.
 * Side-effects: IO (writes `research/delta-minimizing/charter.html`).
 * Links: .claude/skills/delta-minimizer/SKILL.md
 * @public
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(REPO_ROOT, "work/charters/POLY_COPY_DELTA.md");
const DST = join(REPO_ROOT, "research/delta-minimizing/charter.html");

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(s: string): string {
  let r = escapeHtml(s);
  r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
  r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return r;
}

function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  const closeList = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (i === 0 && line.trim() === "---") {
      i++;
      while (i < lines.length && lines[i].trim() !== "---") i++;
      i++;
      continue;
    }
    const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headerMatch) {
      closeList();
      out.push(
        `<h${headerMatch[1].length}>${inline(headerMatch[2])}</h${headerMatch[1].length}>`
      );
      i++;
      continue;
    }
    if (
      /^\|.*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s\-:|]+\|/.test(lines[i + 1])
    ) {
      closeList();
      const headers = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) {
        rows.push(
          lines[i]
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim())
        );
        i++;
      }
      out.push("<table>");
      out.push(
        `<thead><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>`
      );
      out.push(
        `<tbody>${rows
          .map(
            (r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`
          )
          .join("")}</tbody>`
      );
      out.push("</table>");
      continue;
    }
    if (/^- /.test(line)) {
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inline(line.replace(/^- /, ""))}</li>`);
      i++;
      continue;
    }
    if (/^> /.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^> /, ""))}</blockquote>`);
      i++;
      continue;
    }
    if (line.trim() === "") {
      closeList();
      out.push("");
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join("\n");
}

const CSS = `:root { color-scheme: dark; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0e1a; color: #e5e7eb; padding: 32px; max-width: 1100px; margin: 0 auto; line-height: 1.55; }
h1 { font-size: 26px; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-top: 0; }
h2 { font-size: 18px; color: #f3f4f6; margin-top: 28px; }
h3 { font-size: 14px; color: #cbd5e1; }
a { color: #60a5fa; }
code { background: #131826; padding: 1px 6px; border-radius: 3px; font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 12px 0 24px; }
th, td { padding: 8px 10px; border-bottom: 1px solid #1f2937; vertical-align: top; text-align: left; }
th { background: #0e1422; color: #94a3b8; font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
blockquote { border-left: 3px solid #475569; margin: 12px 0; padding: 4px 12px; color: #94a3b8; }
ul { padding-left: 20px; }
strong { color: #f3f4f6; }
.banner { background: #1a1410; border: 1px solid #f59e0b66; border-left-width: 3px; padding: 10px 14px; margin: 0 0 18px; font-size: 12px; color: #cbd5e1; border-radius: 4px; }
.banner code { background: #0a0e1a; }`;

const md = readFileSync(SRC, "utf8");
const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Poly Copy-Trade Δ Charter</title>
<style>${CSS}</style></head><body>
<div class="banner">Static mirror of <code>work/charters/POLY_COPY_DELTA.md</code> &mdash; edits go in the <code>.md</code>, then run <code>pnpm tsx scripts/render-charter.ts</code>. This file is never auto-rewritten by other scripts.</div>
${markdownToHtml(md)}
</body></html>`;
writeFileSync(DST, html);
console.error(`[render-charter] ${SRC} → ${DST}`);
