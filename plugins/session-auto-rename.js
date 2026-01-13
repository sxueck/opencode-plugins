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

function stringFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return raw;
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

function stripJsonComments(text) {
  // Minimal JSONC support: strip // and /* */ comments.
  // This is intentionally simple; keep config files straightforward.
  let out = String(text ?? "");
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|[^:])\/\/.*$/gm, "$1");
  return out;
}

function truncateToChars(text, maxChars) {
  const s = String(text ?? "").trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars)).trimEnd();
}

function cleanTitle(raw, maxChars) {
  let cleaned = stripNoise(raw);
  cleaned = cleaned.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "");
  cleaned = cleaned.split(/[\n\r]/).map((s) => s.trim()).find(Boolean) || cleaned;
  return truncateToChars(cleaned, maxChars);
}

async function readOpenAIConfig(path) {
  const { readFile } = await import("fs/promises");
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(stripJsonComments(raw));
  return parsed && typeof parsed === "object" ? parsed : {};
}

function firstSentence(text) {
  const cleaned = stripNoise(text);
  if (!cleaned) return "";

  // Split on common sentence terminators (Chinese + English).
  // Keep it conservative to avoid chopping on abbreviations.
  const match = cleaned.match(/^(.+?)(?:[。！？!?](?:\s|$)|\.(?:\s|$)|\n|\r|$)/);
  const candidate = (match?.[1] ?? cleaned).trim();

  // If the first sentence is too short, fall back to the full cleaned text.
  return candidate.length >= 2 ? candidate : cleaned;
}

async function openaiGenerateTitleFromText({
  apiKey,
  baseURL,
  model,
  text,
  maxChars,
  timeoutMs,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${String(baseURL).replace(/\/$/, "")}/chat/completions`;

    const trimmed = truncateToChars(String(text ?? ""), 3000);

    const body = {
      model,
      temperature: 0.2,
      max_tokens: 120,
      messages: [
        {
          role: "system",
          content:
            "你是会话标题生成器。根据用户第一句话生成会话标题。只输出标题，不要解释。标题不超过50字。",
        },
        {
          role: "user",
          content: `用户第一句话：\n${trimmed}\n\n请输出标题：`,
        },
      ],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 500)}`);
    }

    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;

    // Enforce 50 chars max (ignore env maxChars beyond 50 per requirement).
    return cleanTitle(content, Math.min(50, maxChars));
  } finally {
    clearTimeout(timeout);
  }
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

async function safeToast(client, variant, title, message, duration = 5000) {
  try {
    if (!client?.tui?.showToast) return;

    try {
      await client.tui.showToast({
        body: {
          title,
          message,
          variant,
          duration,
        },
      });
      return;
    } catch {
      // Fall back to potential direct signature.
    }

    await client.tui.showToast({
      title,
      message,
      variant,
      duration,
    });
  } catch {
    // Ignore toast errors.
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

function extractUserTextFromEvent(event) {
  const props = event?.properties;
  const message = props?.message;

  const role = message?.info?.role || message?.role || props?.role || null;
  if (role !== "user") return "";

  const directText = extractTextOnly(message?.parts);
  if (directText) return directText;

  // Some message-part events include a single part.
  const part = props?.part || props?.messagePart;
  if (part?.type === "text" && !part?.synthetic && typeof part.text === "string") {
    return part.text.trim();
  }

  return "";
}

const renamedOnce = new Set();
const inFlight = new Map();
const toastShown = new Set();


export const SessionAutoRename = async ({ client }) => {
  const enabled = booleanFromEnv("OPENCODE_SESSION_AUTORENAME_ENABLED", true);
  if (!enabled) return {};

  // Requirement: use the first user sentence as summary/title source.

  const maxChars = numberFromEnv("OPENCODE_SESSION_AUTORENAME_MAX_CHARS", 50);
  const minChars = numberFromEnv("OPENCODE_SESSION_AUTORENAME_MIN_CHARS", 3);
  const timeoutMs = numberFromEnv("OPENCODE_SESSION_AUTORENAME_OPENAI_TIMEOUT_MS", 10_000);
  const logOnLoad = booleanFromEnv("OPENCODE_SESSION_AUTORENAME_LOG_ON_LOAD", false);


  const { join } = await import("path");
  const { homedir } = await import("os");

  const openaiConfigPath = stringFromEnv(
    "OPENCODE_SESSION_AUTORENAME_OPENAI_CONFIG",
    join(homedir(), ".config", "opencode", "openai.jsonc"),
  );

  if (logOnLoad) {
    void safeLog(client, "info", "SessionAutoRename plugin loaded", {
      enabled,
      maxChars: Math.min(50, maxChars),
      minChars,
      openaiConfigPath,
      timeoutMs,
    });
  }

  let missingKeyToastShown = false;

  async function loadOpenAISettings() {
    const config = await readOpenAIConfig(openaiConfigPath);
    const configPathUsed = openaiConfigPath;

    const apiKey =
      config.apiKey ||
      config.key ||
      config.openaiApiKey ||
      config.OPENAI_API_KEY ||
      config.openai_api_key;

    const baseURL = config.baseURL || config.baseUrl || "https://api.openai.com/v1";
    const model = config.model || "gpt-4o-mini";

    if (!apiKey || typeof apiKey !== "string" || apiKey.trim() === "") {
      if (!missingKeyToastShown) {
        missingKeyToastShown = true;
        void safeToast(
          client,
          "error",
          "Session auto-rename",
          `Missing OpenAI apiKey in ${configPathUsed} (apiKey/key)`,
          8000,
        );
      }
      throw new Error(
        `Missing OpenAI apiKey in ${configPathUsed}. Expected { apiKey: "..." } or { key: "..." }`,
      );
    }


    return { apiKey: apiKey.trim(), baseURL, model, configPathUsed };
  }


  async function maybeRenameOnFirstMessage(sessionID, seedFromEvent) {
    if (!sessionID) return;
    if (renamedOnce.has(sessionID)) return;
    if (inFlight.has(sessionID)) return inFlight.get(sessionID);

    const promise = (async () => {
      try {
        if (await isSubagentSession(client, sessionID)) return;

        let confirmedFirstUserMessage = false;
        let userText = "";

        // Source of truth: the stored first user message.
        // Retry a few times since the message event may fire before persistence.
        const maxAttempts = 8;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const { data: messages } = await client.session.messages({ path: { id: sessionID } });

          // Only rename based on brand-new sessions (exactly one user message).
          if (countUserMessages(messages) !== 1) return;
          confirmedFirstUserMessage = true;

          const firstUserMessage = findFirstUserMessage(messages);
          userText = firstUserMessage ? extractTextOnly(firstUserMessage.parts) : "";

          if (userText.length >= minChars) break;

          await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 120));
        }

        // If the stored message has no text parts yet, fall back to the event text.
        if (userText.length < minChars && confirmedFirstUserMessage) {
          userText = String(seedFromEvent ?? "").trim();
        }

        if (userText.length < minChars) return;

        const seed = firstSentence(userText);

        const { apiKey, baseURL, model } = await loadOpenAISettings();
        const title = await openaiGenerateTitleFromText({
          apiKey,
          baseURL,
          model,
          text: seed,
          maxChars: Math.min(50, maxChars),
          timeoutMs,
        });

        if (!title || title.length < minChars) return;

        void safeLog(client, "info", "Session title auto-generated (OpenAI)", {
          sessionID,
          title,
          model,
        });

        await client.session.update({
          path: { id: sessionID },
          body: { title },
        });

        renamedOnce.add(sessionID);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void safeLog(client, "warn", "Session auto-rename failed", {
          sessionID,
          error: message,
        });

        if (!toastShown.has(sessionID)) {
          toastShown.add(sessionID);
          void safeToast(
            client,
            "warning",
            "Session auto-rename",
            message,
            8000,
          );
        }
      } finally {
        inFlight.delete(sessionID);
      }
    })();

    inFlight.set(sessionID, promise);
    return promise;
  }


  return {
    event: async ({ event }) => {
      const type = event?.type;
      const sessionID = getSessionIDFromEvent(event);

      if (type === "message.updated" || type === "message.part.updated") {
        const seedFromEvent = extractUserTextFromEvent(event);
        if (sessionID && seedFromEvent.length >= minChars) {
          void maybeRenameOnFirstMessage(sessionID, seedFromEvent);
        }
        return;
      }

      // Fallback: if we miss message events, idle will still attempt rename.
      if (
        (type === "session.status" && event?.properties?.status?.type === "idle") ||
        type === "session.idle"
      ) {
        if (sessionID) void maybeRenameOnFirstMessage(sessionID, "");
      }
    },
  };
};

