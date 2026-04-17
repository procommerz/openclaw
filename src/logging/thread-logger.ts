import { safeJsonStringify } from "../utils/safe-json.js";
import { isLlmTraceEnabled, resolveLlmTraceUrl } from "./llm-trace.js";

export {
  isLlmTraceEnabled,
  postLlmTraceEvent,
  resolveLlmTraceStreamName,
  resolveLlmTraceUrl,
  wrapStreamFnWithLlmRequestTrace,
  postLlmTraceOllamaRequest,
  type LlmRequestTraceContext,
  type LlmTraceEvent,
  type LlmTraceEventType,
} from "./llm-trace.js";

type LegacyMessage = {
  role: string;
  content: string;
};

function formatMessagesForLegacy(
  messages: { content: string | unknown[]; role: string }[],
): LegacyMessage[] {
  return messages.map((message) => {
    let content = "";

    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content
        .map((item: { type?: string; text?: string }) => {
          if (item.type === "text") {
            return item.text;
          }
          if (item.type === "image_url") {
            return "[image]";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }

    return {
      role: message.role,
      content,
    };
  });
}

/**
 * Legacy batch shape for log viewers that expect `{ streamName, messages }`.
 * Prefer `postLlmTraceEvent` with structured `eventType` for new integrations.
 */
export const logMessagesToStreamLogger = async ({
  messages,
  name,
}: {
  messages: { content: string | unknown[]; role: string }[];
  name: string;
}): Promise<boolean> => {
  const url = resolveLlmTraceUrl();
  if (!url || !isLlmTraceEnabled()) {
    return false;
  }

  const formattedMessages = formatMessagesForLegacy(messages);

  const payload = {
    streamName: name,
    messages: formattedMessages,
  };

  const body = safeJsonStringify(payload);
  if (!body) {
    return false;
  }

  try {
    const res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body,
    });
    if (!res.ok) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};
