import twitterText from "twitter-text";

export type LengthCounter = (text: string) => number;

export const countByCodePoints: LengthCounter = (text) => Array.from(text).length;

export const countByTwitterRules: LengthCounter = (text) => {
  const parsed = twitterText.parseTweet(text);
  return parsed.weightedLength;
};

interface SplitOptions {
  maxLength: number;
  countLength: LengthCounter;
  reserveForCounter?: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme"
});

function toGraphemes(input: string): string[] {
  return Array.from(graphemeSegmenter.segment(input), (segment) => segment.segment);
}

function isBreakCandidate(grapheme: string): boolean {
  return /\s/.test(grapheme) || /[.!?,;:]/.test(grapheme);
}

function trimToLimit(text: string, maxLength: number, countLength: LengthCounter): string {
  if (countLength(text) <= maxLength) {
    return text;
  }

  const graphemes = toGraphemes(text);
  let out = "";

  for (const grapheme of graphemes) {
    const candidate = out + grapheme;
    if (countLength(candidate) > maxLength) {
      break;
    }
    out = candidate;
  }

  return out.trimEnd();
}

function splitRaw(text: string, maxLength: number, countLength: LengthCounter): string[] {
  const chunks: string[] = [];
  const graphemes = toGraphemes(text.trim());

  let cursor = 0;

  while (cursor < graphemes.length) {
    let end = cursor;
    let candidate = "";
    let lastBoundary = -1;

    while (end < graphemes.length) {
      const next = candidate + graphemes[end];
      if (countLength(next) > maxLength) {
        break;
      }

      candidate = next;
      if (isBreakCandidate(graphemes[end])) {
        lastBoundary = end;
      }
      end += 1;
    }

    const reachedTextEnd = end >= graphemes.length;

    if (end === cursor) {
      candidate = graphemes[cursor];
      end = cursor + 1;
    } else if (!reachedTextEnd && lastBoundary >= cursor && lastBoundary + 1 < end) {
      const fullWindow = end - cursor;
      const boundaryWindow = lastBoundary + 1 - cursor;
      if (boundaryWindow >= Math.floor(fullWindow * 0.55)) {
        end = lastBoundary + 1;
        candidate = graphemes.slice(cursor, end).join("");
      }
    }

    const cleaned = candidate.trim();
    if (cleaned.length > 0) {
      chunks.push(cleaned);
    }

    cursor = end;

    while (cursor < graphemes.length && /\s/.test(graphemes[cursor])) {
      cursor += 1;
    }
  }

  return chunks;
}

export function splitIntoThread(text: string, options: SplitOptions): string[] {
  const input = text.trim();
  if (!input) {
    return [""];
  }

  const reserveForCounter = options.reserveForCounter ?? 6;
  if (options.countLength(input) <= options.maxLength) {
    return [input];
  }

  const rawChunks = splitRaw(
    input,
    Math.max(1, options.maxLength - reserveForCounter),
    options.countLength
  );

  if (rawChunks.length <= 1) {
    return [trimToLimit(input, options.maxLength, options.countLength)];
  }

  const total = rawChunks.length;
  return rawChunks.map((chunk, index) => {
    const suffix = ` ${index + 1}/${total}`;
    const maxTextLength = options.maxLength - options.countLength(suffix);
    const trimmed = trimToLimit(chunk, maxTextLength, options.countLength);
    return `${trimmed}${suffix}`;
  });
}
