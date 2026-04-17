import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  isLlmTraceEnabled,
  postLlmTraceEvent,
  resolveLlmTraceStreamName,
  wrapStreamFnWithLlmRequestTrace,
} from "./llm-trace.js";

describe("llm-trace", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("resolveLlmTraceStreamName combines session id and run id", () => {
    expect(resolveLlmTraceStreamName({ sessionId: "s", runId: "r" })).toBe("s.r");
    expect(resolveLlmTraceStreamName({ sessionId: undefined, runId: "r" })).toBe("r");
  });

  it("isLlmTraceEnabled requires URL and respects OPENCLAW_LLM_TRACE=0", () => {
    vi.stubEnv("OPENCLAW_LLM_TRACE_URL", "");
    expect(isLlmTraceEnabled()).toBe(false);

    vi.stubEnv("OPENCLAW_LLM_TRACE_URL", "http://127.0.0.1:9797/log");
    vi.stubEnv("OPENCLAW_LLM_TRACE", undefined);
    expect(isLlmTraceEnabled()).toBe(true);

    vi.stubEnv("OPENCLAW_LLM_TRACE", "0");
    expect(isLlmTraceEnabled()).toBe(false);
  });

  it("postLlmTraceEvent POSTs { streamName, event } and includes monotonic seq", async () => {
    vi.stubEnv("OPENCLAW_LLM_TRACE_URL", "http://example.test/llm-trace");
    vi.stubEnv("OPENCLAW_LLM_TRACE", "1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    });
    vi.stubGlobal("fetch", fetchMock);

    postLlmTraceEvent({
      eventType: "tool_start",
      ts: 1,
      streamName: "unique-session-1.unique-run-1",
      runId: "unique-run-1",
      sessionId: "unique-session-1",
      toolName: "bash",
      toolCallId: "c1",
      args: { cmd: "echo" },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse(String(init?.body)) as {
      streamName: string;
      event: { eventType: string; seq: number; args: unknown };
    };
    expect(parsed.streamName).toBe("unique-session-1.unique-run-1");
    expect(parsed.event.eventType).toBe("tool_start");
    expect(parsed.event.seq).toBe(1);
    expect(parsed.event.args).toEqual({ cmd: "echo" });
  });

  it("postLlmTraceEvent serializes BigInt and other safe-json replacer values", async () => {
    vi.stubEnv("OPENCLAW_LLM_TRACE_URL", "http://example.test/llm-trace");
    vi.stubEnv("OPENCLAW_LLM_TRACE", "1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    postLlmTraceEvent({
      eventType: "model_request",
      ts: 1,
      streamName: "unique-session-2.unique-run-2",
      runId: "unique-run-2",
      sessionId: "unique-session-2",
      requestIndex: 0,
      provider: "openrouter",
      modelId: "x",
      modelApi: "openai-completions",
      payload: { n: BigInt(42) },
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const parsed = JSON.parse(String(init?.body)) as { event: { payload: { n: string } } };
    expect(parsed.event.payload.n).toBe("42");
  });

  it("wrapStreamFnWithLlmRequestTrace invokes inner onPayload and logs requestIndex", async () => {
    vi.stubEnv("OPENCLAW_LLM_TRACE_URL", "http://example.test/llm-trace");
    vi.stubEnv("OPENCLAW_LLM_TRACE", "1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);

    const inner: StreamFn = (_model, _context, options) => {
      options?.onPayload?.({ messages: [{ role: "user", content: "hi" }] });
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = wrapStreamFnWithLlmRequestTrace(inner, {
      streamName: "unique-session-3.unique-run-3",
      sessionId: "unique-session-3",
      runId: "unique-run-3",
      provider: "openrouter",
      modelId: "openai/gpt-4",
      modelApi: "openai-completions",
    });

    void wrapped({} as never, {} as never, {});

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const parsed = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
      event: { eventType: string; requestIndex: number; payload: { messages: unknown[] } };
    };
    expect(parsed.event.eventType).toBe("model_request");
    expect(parsed.event.requestIndex).toBe(0);
    expect(parsed.event.payload.messages).toHaveLength(1);
  });
});
