import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-drop-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

describe("createOpenClawTools dropBuiltInTools", () => {
  it("drops configured built-in tools for the active agent only", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            imageModel: { primary: "openai/gpt-5-mini" },
            pdfModel: { primary: "openai/gpt-5-mini" },
          },
          list: [
            {
              id: "main",
              tools: {
                dropBuiltInTools: ["browser", "canvas", "web_search", "image", "pdf"],
              },
            },
            {
              id: "other",
            },
          ],
        },
      };

      const droppedNames = new Set(
        createOpenClawTools({
          config: cfg,
          agentDir,
          agentSessionKey: "main",
        }).map((tool) => tool.name),
      );

      expect(droppedNames.has("browser")).toBe(false);
      expect(droppedNames.has("canvas")).toBe(false);
      expect(droppedNames.has("web_search")).toBe(false);
      expect(droppedNames.has("image")).toBe(false);
      expect(droppedNames.has("pdf")).toBe(false);
      expect(droppedNames.has("web_fetch")).toBe(true);

      const otherNames = new Set(
        createOpenClawTools({
          config: cfg,
          agentDir,
          agentSessionKey: "agent:other:main",
        }).map((tool) => tool.name),
      );

      expect(otherNames.has("browser")).toBe(true);
      expect(otherNames.has("canvas")).toBe(true);
      expect(otherNames.has("web_search")).toBe(true);
      expect(otherNames.has("image")).toBe(true);
      expect(otherNames.has("pdf")).toBe(true);
    });
  });
});
