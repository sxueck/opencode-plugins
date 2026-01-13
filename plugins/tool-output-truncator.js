import { tool } from "@opencode-ai/plugin";

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

function countLines(text) {
  // Match `text.split("\n").length` semantics without allocating.
  if (text.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function sliceHeadLines(text, keep, totalLines) {
  if (keep <= 0) return "";
  if (keep >= totalLines) return text;

  let newlineCount = 0;
  let idx = -1;
  while (newlineCount < keep) {
    idx = text.indexOf("\n", idx + 1);
    if (idx === -1) return text;
    newlineCount++;
  }
  return text.slice(0, idx);
}

function sliceTailLines(text, keep) {
  if (keep <= 0) return "";

  let newlineCount = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== 10) continue;
    newlineCount++;
    if (newlineCount === keep) return text.slice(i + 1);
  }

  // Not enough newlines; keep everything.
  return text;
}

function getSizeMeta(text) {
  return {
    totalChars: text.length,
    totalBytes: Buffer.byteLength(text, "utf8"),
    totalLines: countLines(text),
  };
}

function isWithinLimits(meta, limits) {
  return meta.totalChars <= limits.maxChars && meta.totalBytes <= limits.maxBytes && meta.totalLines <= limits.maxLines;
}

function compressConsecutiveDuplicateLines(text, { markerPrefix }) {
  if (text.length === 0) {
    return {
      text,
      meta: {
        collapsedLineRuns: 0,
        collapsedLines: 0,
      },
    };
  }

  const out = [];
  let prevLine;
  let repeatCount = 0;

  let collapsedLineRuns = 0;
  let collapsedLines = 0;

  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;

    const line = text.slice(start, end);

    if (prevLine === undefined) {
      prevLine = line;
      repeatCount = 1;
    } else if (line === prevLine) {
      repeatCount++;
    } else {
      out.push(prevLine);
      if (repeatCount > 1) {
        collapsedLineRuns++;
        collapsedLines += repeatCount - 1;
        out.push(`${markerPrefix} repeated previous line ${repeatCount - 1} more times ${markerPrefix}`);
      }
      prevLine = line;
      repeatCount = 1;
    }

    if (end === text.length) break;
    start = end + 1;
  }

  out.push(prevLine ?? "");
  if (repeatCount > 1) {
    collapsedLineRuns++;
    collapsedLines += repeatCount - 1;
    out.push(`${markerPrefix} repeated previous line ${repeatCount - 1} more times ${markerPrefix}`);
  }

  return {
    text: out.join("\n"),
    meta: {
      collapsedLineRuns,
      collapsedLines,
    },
  };
}

function blocksEqual(lines, startA, startB, size) {
  for (let i = 0; i < size; i++) {
    if (lines[startA + i] !== lines[startB + i]) return false;
  }
  return true;
}

function compressConsecutiveRepeatedBlocks(text, { markerPrefix, maxBlockSize, maxScanLines }) {
  const totalLines = countLines(text);
  if (totalLines > maxScanLines) {
    return {
      text,
      meta: {
        collapsedBlocks: 0,
        collapsedBlockRepeats: 0,
        skipped: true,
      },
    };
  }

  const lines = text.split("\n");
  const out = [];

  let collapsedBlocks = 0;
  let collapsedBlockRepeats = 0;

  let i = 0;
  while (i < lines.length) {
    const remaining = lines.length - i;
    const maxSize = Math.min(maxBlockSize, Math.floor(remaining / 2));

    let matchedSize = 0;
    let matchedBlocks = 0;

    for (let size = maxSize; size >= 2; size--) {
      if (!blocksEqual(lines, i, i + size, size)) continue;

      let blocks = 2;
      while (i + blocks * size <= lines.length && blocksEqual(lines, i, i + (blocks - 1) * size, size)) {
        blocks++;
      }

      matchedSize = size;
      matchedBlocks = blocks - 1;
      break;
    }

    if (matchedSize > 0 && matchedBlocks >= 2) {
      out.push(...lines.slice(i, i + matchedSize));
      const more = matchedBlocks - 1;
      collapsedBlocks++;
      collapsedBlockRepeats += more;
      out.push(`${markerPrefix} repeated previous ${matchedSize} lines ${more} more times ${markerPrefix}`);
      i += matchedBlocks * matchedSize;
      continue;
    }

    out.push(lines[i]);
    i++;
  }

  return {
    text: out.join("\n"),
    meta: {
      collapsedBlocks,
      collapsedBlockRepeats,
      skipped: false,
    },
  };
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeKeepLineCounts(totalLines, maxLines) {
  // Reserve 1 line for the omission marker.
  const budget = Math.max(0, maxLines - 1);
  if (budget <= 0) return { keepHead: 0, keepTail: 0 };

  // Bias toward tail (errors/results usually near the end), but keep some head for context.
  const desiredHead = clampInt(Math.floor(maxLines * 0.15), 10, 50);
  const keepHead = Math.min(desiredHead, Math.max(0, totalLines));
  const keepTail = Math.max(0, Math.min(totalLines - keepHead, budget - keepHead));

  return { keepHead, keepTail };
}

function truncateText(text, limits) {
  const { maxChars, maxBytes, maxLines, markerPrefix } = limits;

  const bytes = Buffer.byteLength(text, "utf8");
  const totalLines = countLines(text);

  const withinChars = text.length <= maxChars;
  const withinBytes = bytes <= maxBytes;
  const withinLines = totalLines <= maxLines;

  if (withinChars && withinBytes && withinLines) {
    return {
      truncated: false,
      text,
      meta: {
        totalChars: text.length,
        totalBytes: bytes,
        totalLines,
      },
    };
  }

  const { keepHead, keepTail } = computeKeepLineCounts(totalLines, maxLines);

  const head = sliceHeadLines(text, keepHead, totalLines);
  const tail = sliceTailLines(text, keepTail);
  const omitted = Math.max(0, totalLines - keepHead - keepTail);

  let candidate =
    omitted > 0
      ? `${head}\n${markerPrefix} omitted ${omitted} lines ${markerPrefix}\n${tail}`
      : text;

  // If line-based truncation isn't enough, enforce hard char/byte caps.
  if (candidate.length > maxChars || Buffer.byteLength(candidate, "utf8") > maxBytes) {
    const hardMarker = `${markerPrefix} truncated to ${maxChars} chars / ${maxBytes} bytes ${markerPrefix}`;
    const room = Math.max(0, maxChars - hardMarker.length - 2);
    const sliced = candidate.slice(0, room);
    candidate = `${sliced}\n${hardMarker}`;
  }

  return {
    truncated: true,
    text: candidate,
    meta: {
      totalChars: text.length,
      totalBytes: bytes,
      totalLines,
      keptHeadLines: keepHead,
      keptTailLines: keepTail,
      omittedLines: omitted,
    },
  };
}

function reduceText(text, limits) {
  const originalMeta = getSizeMeta(text);
  if (isWithinLimits(originalMeta, limits)) {
    return {
      text,
      compressed: false,
      truncated: false,
      meta: {
        original: originalMeta,
      },
    };
  }

  let currentText = text;
  let compressionMeta;

  if (limits.compressRepeats) {
    compressionMeta = {
      collapsedLineRuns: 0,
      collapsedLines: 0,
      collapsedBlocks: 0,
      collapsedBlockRepeats: 0,
      blockCompressionSkipped: false,
    };

    const lineCompressed = compressConsecutiveDuplicateLines(currentText, {
      markerPrefix: limits.markerPrefix,
    });
    currentText = lineCompressed.text;
    compressionMeta.collapsedLineRuns = lineCompressed.meta.collapsedLineRuns;
    compressionMeta.collapsedLines = lineCompressed.meta.collapsedLines;

    const blockCompressed = compressConsecutiveRepeatedBlocks(currentText, {
      markerPrefix: limits.markerPrefix,
      maxBlockSize: limits.compressBlockMaxSize,
      maxScanLines: limits.compressBlockMaxScanLines,
    });
    currentText = blockCompressed.text;
    compressionMeta.collapsedBlocks = blockCompressed.meta.collapsedBlocks;
    compressionMeta.collapsedBlockRepeats = blockCompressed.meta.collapsedBlockRepeats;
    compressionMeta.blockCompressionSkipped = blockCompressed.meta.skipped;
  }

  const didCompress = currentText !== text;
  const afterCompressionMeta = getSizeMeta(currentText);

  if (isWithinLimits(afterCompressionMeta, limits)) {
    return {
      text: currentText,
      compressed: didCompress,
      truncated: false,
      meta: {
        original: originalMeta,
        ...(didCompress
          ? {
              compressed: afterCompressionMeta,
              compression: compressionMeta,
            }
          : {}),
      },
    };
  }

  const truncated = truncateText(currentText, limits);
  return {
    text: truncated.text,
    compressed: didCompress,
    truncated: true,
    meta: {
      original: originalMeta,
      ...(didCompress
        ? {
            compressed: afterCompressionMeta,
            compression: compressionMeta,
          }
        : {}),
      truncation: truncated.meta,
    },
  };
}

export const ToolOutputTruncator = async ({ client, $ }) => {
  const defaults = {
    enabled: booleanFromEnv("OPENCODE_TOOL_TRUNCATE_ENABLED", true),
    maxChars: numberFromEnv("OPENCODE_TOOL_TRUNCATE_MAX_CHARS", 120_000),
    maxBytes: numberFromEnv("OPENCODE_TOOL_TRUNCATE_MAX_BYTES", 200_000),
    maxLines: numberFromEnv("OPENCODE_TOOL_TRUNCATE_MAX_LINES", 800),

    // Keep repeat compression always on by default; avoid exposing a lot of knobs.
    compressRepeats: true,
    compressBlockMaxSize: 20,
    compressBlockMaxScanLines: 5_000,

    markerPrefix: "---",
  };

  const logOnLoad = booleanFromEnv("OPENCODE_TOOL_TRUNCATE_LOG_ON_LOAD", false);
  if (logOnLoad) {
    // Don't block plugin initialization on logging.
    const logPromise = client.app.log({
      service: "tool-output-truncator",
      level: "info",
      message: "ToolOutputTruncator plugin loaded",
      extra: {
        enabled: defaults.enabled,
        maxChars: defaults.maxChars,
        maxBytes: defaults.maxBytes,
        maxLines: defaults.maxLines,
        compressRepeats: defaults.compressRepeats,
      },
    });

    const timeout = new Promise((resolve) => setTimeout(resolve, 1000));
    void Promise.race([logPromise, timeout]).catch(() => {});
  }

  return {
    tool: {
      truncated_bash: tool({
        description: "Run a shell command and return reduced output with metadata.",
        args: {
          command: tool.schema.string().min(1),
          cwd: tool.schema.string().optional(),
          maxChars: tool.schema.number().int().positive().optional(),
          maxBytes: tool.schema.number().int().positive().optional(),
          maxLines: tool.schema.number().int().positive().optional(),
          includeStderr: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const runner = args.cwd ? $.cwd(args.cwd) : $;
          const includeStderr = args.includeStderr ?? true;

          const result = await runner`${{ raw: args.command }}`.nothrow().quiet();

          const stdout = result.stdout.toString("utf8");
          const stderr = result.stderr.toString("utf8");

          const combined = includeStderr
            ? `# exitCode: ${result.exitCode}\n\n## stdout\n${stdout}\n\n## stderr\n${stderr}`
            : `# exitCode: ${result.exitCode}\n\n${stdout}`;

          const limits = {
            ...defaults,
            maxChars: args.maxChars ?? defaults.maxChars,
            maxBytes: args.maxBytes ?? defaults.maxBytes,
            maxLines: args.maxLines ?? defaults.maxLines,
          };

          const reduced = reduceText(combined, limits);
          if (!reduced.compressed && !reduced.truncated) return reduced.text;

          const marker = reduced.truncated
            ? `${limits.markerPrefix} output truncated ${limits.markerPrefix}`
            : `${limits.markerPrefix} output compressed ${limits.markerPrefix}`;

          let suffix = `\n\n${marker}`;
          suffix += `\n(originalLines=${reduced.meta.original.totalLines}, originalBytes=${reduced.meta.original.totalBytes})`;
          if (reduced.meta.compressed) {
            suffix += `\n(afterCompressionLines=${reduced.meta.compressed.totalLines}, afterCompressionBytes=${reduced.meta.compressed.totalBytes})`;
          }

          return `${reduced.text}${suffix}`;
        },
      }),
    },

    "tool.execute.after": async (input, output) => {
      if (!defaults.enabled) return;

      // Avoid re-truncating our own output.
      if (input.tool === "truncated_bash") return;

      const text = typeof output.output === "string" ? output.output : String(output.output ?? "");
      const reduced = reduceText(text, defaults);
      if (!reduced.compressed && !reduced.truncated) return;

      const noteLines = [
        "",
        reduced.truncated
          ? `${defaults.markerPrefix} tool output truncated ${defaults.markerPrefix}`
          : `${defaults.markerPrefix} tool output compressed ${defaults.markerPrefix}`,
        `tool=${input.tool} callID=${input.callID}`,
        `originalLines=${reduced.meta.original.totalLines} originalBytes=${reduced.meta.original.totalBytes}`,
      ];

      if (reduced.meta.compressed) {
        noteLines.push(
          `afterCompressionLines=${reduced.meta.compressed.totalLines} afterCompressionBytes=${reduced.meta.compressed.totalBytes}`,
        );
      }

      output.output = `${reduced.text}${noteLines.join("\n")}`;
      output.metadata = {
        ...(output.metadata ?? {}),
        tool_output_truncator: {
          truncated: reduced.truncated,
          compressed: reduced.compressed,
          ...reduced.meta,
        },
      };
    },
  };
};
