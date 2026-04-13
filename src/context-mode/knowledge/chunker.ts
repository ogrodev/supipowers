export interface Chunk {
  title: string;
  body: string;
  contentType: "code" | "prose";
  source: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)/;
const FENCE_RE = /^(`{3,})/;
const MAX_CHUNK_SIZE = 4096;

/**
 * Split markdown into searchable chunks by heading boundaries.
 * Never splits inside fenced code blocks. Oversized chunks split at paragraph boundaries.
 */
export function chunkMarkdown(text: string, source: string): Chunk[] {
  if (!text) return [];

  const sections = splitByHeadings(text, source);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const body = section.body.trim();
    if (!body) continue;

    if (body.length <= MAX_CHUNK_SIZE) {
      chunks.push({
        title: section.title,
        body,
        contentType: classifyContent(body),
        source,
      });
    } else {
      const parts = splitOversized(body);
      for (let i = 0; i < parts.length; i++) {
        const partBody = parts[i].trim();
        if (!partBody) continue;
        chunks.push({
          title: `${section.title} (part ${i + 1})`,
          body: partBody,
          contentType: classifyContent(partBody),
          source,
        });
      }
    }
  }

  return chunks;
}

interface RawSection {
  title: string;
  body: string;
}

/** Split text into sections at heading boundaries, respecting fenced code blocks. */
function splitByHeadings(text: string, source: string): RawSection[] {
  const lines = text.split("\n");
  const sections: RawSection[] = [];
  let currentTitle = source;
  let currentLines: string[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    if (inFence) {
      currentLines.push(line);
      // Check if this line closes the fence
      const closeMatch = line.match(FENCE_RE);
      if (closeMatch && line.trimStart().startsWith(fenceMarker) && !line.trimStart().slice(fenceMarker.length).match(/\S/)) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    // Check for opening fence
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      // Opening fence: backticks followed optionally by a language hint
      inFence = true;
      fenceMarker = fenceMatch[1];
      currentLines.push(line);
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      // Flush previous section
      sections.push({ title: currentTitle, body: currentLines.join("\n") });
      currentTitle = headingMatch[2];
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  sections.push({ title: currentTitle, body: currentLines.join("\n") });

  return sections;
}

/** Classify body as "code" or "prose" based on fenced code block character ratio. */
function classifyContent(body: string): "code" | "prose" {
  let codeChars = 0;
  let inFence = false;
  let fenceMarker = "";
  let blockLines: string[] = [];

  for (const line of body.split("\n")) {
    if (inFence) {
      const closeMatch = line.match(FENCE_RE);
      if (closeMatch && line.trimStart().startsWith(fenceMarker) && !line.trimStart().slice(fenceMarker.length).match(/\S/)) {
        inFence = false;
        codeChars += blockLines.join("\n").length;
        blockLines = [];
        fenceMarker = "";
      } else {
        blockLines.push(line);
      }
      continue;
    }

    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[1];
      blockLines = [];
    }
  }

  // If still in fence (unclosed), count accumulated lines
  if (inFence) {
    codeChars += blockLines.join("\n").length;
  }

  return codeChars > body.length * 0.5 ? "code" : "prose";
}

/**
 * Split oversized body at paragraph boundaries (\n\n), never breaking inside code fences.
 * Returns parts each ≤ MAX_CHUNK_SIZE (best effort — a single paragraph exceeding the limit is kept whole).
 */
function splitOversized(body: string): string[] {
  // Identify paragraph boundaries that are outside code fences
  const splitPoints = findSafeSplitPoints(body);

  if (splitPoints.length === 0) {
    // No safe split points — return as single part
    return [body];
  }

  const parts: string[] = [];
  let start = 0;

  for (const point of splitPoints) {
    const candidate = body.slice(start, point).trim();
    if (!candidate) {
      start = point;
      continue;
    }

    // Check if adding this segment to the current accumulation would exceed the limit
    if (parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last.length + candidate.length + 2 <= MAX_CHUNK_SIZE) {
        parts[parts.length - 1] = last + "\n\n" + candidate;
        start = point;
        continue;
      }
    }

    // Start a new part, greedily accumulating paragraphs up to the limit
    if (parts.length === 0 || parts[parts.length - 1].length > 0) {
      parts.push(candidate);
    }
    start = point;
  }

  // Handle remaining text after last split point
  const remaining = body.slice(start).trim();
  if (remaining) {
    if (parts.length > 0) {
      const last = parts[parts.length - 1];
      if (last.length + remaining.length + 2 <= MAX_CHUNK_SIZE) {
        parts[parts.length - 1] = last + "\n\n" + remaining;
      } else {
        parts.push(remaining);
      }
    } else {
      parts.push(remaining);
    }
  }

  return parts;
}

/** Find byte offsets of `\n\n` boundaries that are NOT inside fenced code blocks. */
function findSafeSplitPoints(body: string): number[] {
  const points: number[] = [];
  let inFence = false;
  let fenceMarker = "";
  let i = 0;

  const lines = body.split("\n");
  let offset = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (inFence) {
      const closeMatch = line.match(FENCE_RE);
      if (closeMatch && line.trimStart().startsWith(fenceMarker) && !line.trimStart().slice(fenceMarker.length).match(/\S/)) {
        inFence = false;
        fenceMarker = "";
      }
    } else {
      const fenceMatch = line.match(FENCE_RE);
      if (fenceMatch) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      }
    }

    // A blank line outside a fence is a paragraph boundary (\n\n in the original text)
    if (!inFence && line === "") {
      points.push(offset + 1); // offset after the blank line's \n
    }

    offset += line.length + 1; // +1 for the \n
  }

  return points;
}
