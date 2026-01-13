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

/**
 * Extract only user-authored text parts.
 * OpenCode message parts may include synthetic content that should not influence titles.
 */
function extractTextOnly(parts) {
  if (!Array.isArray(parts)) return "";
  const textParts = parts.filter((part) => part?.type === "text" && !part?.synthetic);
  return textParts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function stripNoise(text) {
  let cleaned = String(text ?? "");

  // Remove think tags.
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

  // Remove fenced code blocks.
  cleaned = cleaned.replace(/```[\s\S]*?```/g, " ");

  // Drop inline code ticks but keep contents.
  cleaned = cleaned.replace(/`([^`]+)`/g, "$1");

  // Collapse whitespace.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  // Remove leading markdown heading markers.
  cleaned = cleaned.replace(/^#+\s*/, "");

  // Remove leading opencode commands/agent mentions.
  cleaned = cleaned.replace(/^\s*[\/\\]\s*/, "");
  cleaned = cleaned.replace(/^\s*@\w+\s*/, "");

  return cleaned.trim();
}

function truncateToChars(text, maxChars) {
  const s = String(text ?? "").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars)).trimEnd();
}

function stripFillerPhrases(text) {
  let s = String(text ?? "").trim();

  // Strip some common leading polite/filler phrases (conservative).
  // Keep this list short to avoid removing meaningful content.
  const leadingPatterns = [
    /^\s*(?:请|麻烦|劳烦)\s*(?:帮我|帮忙)?\s*/,
    /^\s*(?:帮我|帮忙)\s*/,
    /^\s*(?:能不能|能否|可以不可以|可不可以)\s*/,
    /^\s*(?:我想|我需要|我要|想要|希望|需要)\s*/,
    /^\s*(?:例如|比如)(?:的)?\s*/,
    /^\s*(?:这个|这种|这样的|这类|此类)\s*/,
  ];

  for (const re of leadingPatterns) s = s.replace(re, "");

  // Strip some common trailing filler phrases.
  s = s.replace(/\s*(?:之类的?|等等|什么的|啥的)\s*$/g, "");

  // Specific phrasing like "这个之类的" usually carries no meaning.
  s = s.replace(/\s*这个之类的?\s*/g, " ");

  // Collapse whitespace again.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function cleanTitle(raw, maxChars) {
  let cleaned = stripNoise(raw);
  cleaned = cleaned.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "");
  cleaned = cleaned.split(/[\n\r]/).map((s) => s.trim()).find(Boolean) || cleaned;
  return truncateToChars(cleaned, maxChars);
}

function takeFirstSentence(text) {
  const s = String(text ?? "").trim();
  const idx = s.search(/[。！？!?]/);
  if (idx === -1) return s;
  return s.slice(0, idx).trim();
}

function cleanUserTitle(raw, maxChars) {
  const limit = Math.min(30, Math.max(1, Number(maxChars) || 30));

  const base = cleanTitle(raw, Math.max(limit, 80));
  const stripped = stripFillerPhrases(base);
  const firstSentence = takeFirstSentence(stripped || base);

  const normalized = String(firstSentence).replace(/^\s*的\s*/, "").trim();

  return truncateToChars(normalized || firstSentence || stripped || base, limit);
}

async function safeLog(client, level, message, extra) {
  try {
    if (!client?.app?.log) return;

    // Different opencode versions expose slightly different SDK shapes.
    // Prefer the newer (no-body) signature used by bundled plugins.
    try {
      await client.app.log({
        service: "session-auto-rename",
        level,
        message,
        extra,
      });
      return;
    } catch {
      // Fall back to OpenAPI-style { body } wrapper.
    }

    await client.app.log({
      body: {
        service: "session-auto-rename",
        level,
        message,
        extra,
      },
    });
  } catch {
    // Ignore logging errors.
  }
}

async function isSubagentSession(client, sessionID) {
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    return Boolean(result?.data?.parentID);
  } catch {
    return false;
  }
}

function findFirstUserMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    if (msg?.info?.role === "user") return msg;
  }
  return null;
}

function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const msg of messages) {
    if (msg?.info?.role === "user") count++;
  }
  return count;
}

function getSessionIDFromEvent(event) {
  const props = event?.properties;
  return (
    props?.sessionID ||
    props?.sessionId ||
    props?.id ||
    props?.session?.id ||
    props?.session?.ID ||
    props?.message?.sessionID ||
    props?.message?.sessionId ||
    null
  );
}

const renamedOnce = new Set();
const inFlight = new Map();

export const SessionAutoRename = async ({ client }) => {
  const enabled = booleanFromEnv("OPENCODE_SESSION_AUTORENAME_ENABLED", true);
  if (!enabled) return {};

  const maxChars = numberFromEnv("OPENCODE_SESSION_AUTORENAME_MAX_CHARS", 50);
  const minChars = numberFromEnv("OPENCODE_SESSION_AUTORENAME_MIN_CHARS", 3);
  const logOnLoad = booleanFromEnv("OPENCODE_SESSION_AUTORENAME_LOG_ON_LOAD", false);

  const effectiveMaxChars = Math.min(50, maxChars);

  if (logOnLoad) {
    void safeLog(client, "info", "SessionAutoRename plugin loaded", {
      enabled,
      maxChars: effectiveMaxChars,
      minChars,
    });
  }

  async function maybeRenameOnFirstMessage(sessionID) {
    if (!sessionID) return;
    if (renamedOnce.has(sessionID)) return;
    if (inFlight.has(sessionID)) return inFlight.get(sessionID);

    const promise = (async () => {
      try {
        if (await isSubagentSession(client, sessionID)) return;

        const { data: messages } = await client.session.messages({ path: { id: sessionID } });

        // Only rename on the very first user message.
        if (countUserMessages(messages) !== 1) return;

        const firstUserMessage = findFirstUserMessage(messages);
        const userText = firstUserMessage ? extractTextOnly(firstUserMessage.parts) : "";

        if (userText.length < minChars) return;

        const title = cleanUserTitle(userText, effectiveMaxChars);
        if (!title || title.length < minChars) return;

        await client.session.update({
          path: { id: sessionID },
          body: { title },
        });

        renamedOnce.add(sessionID);

        void safeLog(client, "info", "Session title set from first user message", {
          sessionID,
          title,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void safeLog(client, "warn", "Session auto-rename failed", {
          sessionID,
          error: message,
        });
      } finally {
        inFlight.delete(sessionID);
      }
    })();

    inFlight.set(sessionID, promise);
    return promise;
  }

  return {
    event: async ({ event }) => {
      const sessionID = getSessionIDFromEvent(event);
      const type = event?.type;

      // Prefer renaming as soon as the first user message arrives.
      // message.updated behaves like an upsert and is the earliest stable hook.
      if (type === "message.updated") {
        void maybeRenameOnFirstMessage(sessionID);
      }

      // Fallback hooks in case some clients don't emit message events.
      if (type === "session.status" && event?.properties?.status?.type === "idle") {
        // @ts-ignore
        void maybeRenameOnFirstMessage(event.properties.sessionID);
      }

      if (type === "session.idle") {
        // @ts-ignore
        void maybeRenameOnFirstMessage(event?.properties?.sessionID);
      }
    },
  };
};
