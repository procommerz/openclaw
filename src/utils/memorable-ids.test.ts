import { describe, expect, it } from "vitest";
import {HumanizedIdStore, memorableToOriginalId, getMemorableId} from "./memorable-ids.js";

describe("memorableIds", () => {
  it("generates memorable ids", () => {
    const store = new HumanizedIdStore({});
    const scope = "test-scope";
    const originalId = "1234567890";
    const humanizedId = store.getMemorableId(scope, originalId);

    console.log("originalId", originalId, "humanizedId", humanizedId);

    expect(humanizedId).not.toBe(originalId);
    const originalId2 = store.getOriginalId(scope, humanizedId);
    expect(originalId2).toBe(originalId);

    const humanizedId2 = getMemorableId(scope, originalId);
    expect(humanizedId2).toBe(humanizedId);

    const originalId3 = memorableToOriginalId(scope, humanizedId2);
    expect(originalId3).toBe(originalId);
  });
});
