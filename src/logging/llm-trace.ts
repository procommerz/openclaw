import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "./subsystem.js";
import { safeJsonStringify, safeJsonStringifyPretty } from "../utils/safe-json.js";

const log = createSubsystemLogger("logging/llm-trace");

/** Per-streamName monotonic sequence for correlating events in the trace viewer. */
const seqByStreamName = new Map<string, number>();

function nextStreamSeq(streamName: string): number {
  const next = (seqByStreamName.get(streamName) ?? 0) + 1;
  seqByStreamName.set(streamName, next);
  return next;
}

export function resolveLlmTraceStreamName(params: {
  sessionId?: string;
  runId: string;
}): string {
  const sid = params.sessionId?.trim();
  return sid ? `${sid}.${params.runId}` : params.runId;
}

/**
 * When non-empty, POST structured trace events to this URL (JSON body).
 * Set `OPENCLAW_LLM_TRACE=0` to disable even if URL is set.
 */
export function resolveLlmTraceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_LLM_TRACE_URL?.trim() ?? "";
}

export function isLlmTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPENCLAW_LLM_TRACE === "0") {
    return false;
  }
  return resolveLlmTraceUrl(env).length > 0;
}

export type LlmTraceEventType =
  | "model_request"
  | "assistant_thinking_stream"
  | "assistant_text_stream"
  | "assistant_message_end"
  | "assistant_message_start"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_summary"
  /** @deprecated Prefer structured events; kept for older log viewers. */
  | "legacy_messages";

export type LlmTraceEvent = {
  eventType: LlmTraceEventType;
  ts: number;
  streamName: string;
  sessionId?: string;
  sessionKey?: string;
  runId: string;
  agentId?: string;
  /** Monotonic per streamName for ordering in the viewer. */
  seq: number;
} & Record<string, unknown>;

export type LlmRequestTraceContext = {
  streamName: string;
  sessionId?: string;
  sessionKey?: string;
  runId: string;
  provider: string;
  modelId: string;
  modelApi?: string | null;
  agentId?: string;
};

/**
 * Fire-and-forget POST of one trace event. Never throws synchronously; logs failures.
 */
export function postLlmTraceEvent(
  partial: Omit<LlmTraceEvent, "seq"> & { streamName: string; runId: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isLlmTraceEnabled(env)) {
    return;
  }
  const url = resolveLlmTraceUrl(env);
  if (!url) {
    return;
  }

  // Skip high-frequency streaming deltas; assistant_message_end carries the full text.
  if (partial.eventType === "assistant_text_stream") {
    return;
  }

  const seq = nextStreamSeq(partial.streamName);
  const event: LlmTraceEvent = {
    ...partial,
    seq,
  };

  // Wrap in the legacy { streamName, messages } shape so existing log viewers can consume it.
  // eventType becomes the message role; the full event object is serialized as the content.
  // Pretty-print with real newlines so long prompt texts are readable in log viewers.
  const content = safeJsonStringifyPretty(event);
  if (!content) {
    log.warn("llm trace: failed to serialize event", { eventType: partial.eventType });
    return;
  }
  const body = safeJsonStringify({
    streamName: partial.streamName,
    messages: [{ role: partial.eventType, content }],
  });
  if (!body) {
    log.warn("llm trace: failed to build body", { eventType: partial.eventType });
    return;
  }

  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then((res) => {
      if (!res.ok) {
        log.warn(`llm trace: HTTP ${res.status} ${res.statusText}`);
      }
    })
    .catch((err) => {
      log.warn(`llm trace: POST failed: ${String(err)}`);
    });
}

/**
 * Wrap `streamFn` to log each outbound provider payload via `onPayload`, after all inner mutations.
 * Increments `requestIndex` per HTTP/SDK request within the agent loop.
 */
export function wrapStreamFnWithLlmRequestTrace(
  streamFn: StreamFn,
  ctx: LlmRequestTraceContext,
  env: NodeJS.ProcessEnv = process.env,
): StreamFn {
  if (!isLlmTraceEnabled(env)) {
    return streamFn;
  }

  let requestIndex = 0;
  return (model, context, options) => {
    const onPayload = options?.onPayload;
    return streamFn(model, context, {
      ...options,
      onPayload: (payload: unknown) => {
        const idx = requestIndex;
        requestIndex += 1;
        postLlmTraceEvent(
          {
            eventType: "model_request",
            ts: Date.now(),
            streamName: ctx.streamName,
            sessionId: ctx.sessionId,
            sessionKey: ctx.sessionKey,
            runId: ctx.runId,
            agentId: ctx.agentId,
            requestIndex: idx,
            provider: ctx.provider,
            modelId: ctx.modelId,
            modelApi: ctx.modelApi,
            payload,
          },
          env,
        );
        onPayload?.(payload);
      },
    });
  };
}

/**
 * Log Ollama native `/api/chat` body (no `onPayload` on that path).
 */
export function postLlmTraceOllamaRequest(params: {
  ctx: LlmRequestTraceContext;
  body: unknown;
  requestIndex: number;
  env?: NodeJS.ProcessEnv;
}): void {
  postLlmTraceEvent(
    {
      eventType: "model_request",
      ts: Date.now(),
      streamName: params.ctx.streamName,
      sessionId: params.ctx.sessionId,
      sessionKey: params.ctx.sessionKey,
      runId: params.ctx.runId,
      agentId: params.ctx.agentId,
      requestIndex: params.requestIndex,
      provider: params.ctx.provider,
      modelId: params.ctx.modelId,
      modelApi: params.ctx.modelApi,
      transport: "ollama_native",
      payload: params.body,
    },
    params.env,
  );
}
