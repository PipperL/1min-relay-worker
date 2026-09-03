import { describe, expect, it } from "vitest";
import { buildModelObject } from "../src/handlers/models";
import type { OneMinModelEntry } from "../src/types/onemin-models";

const FETCHED_AT = 1_756_887_227_000;

function entry(overrides: Partial<OneMinModelEntry> = {}): OneMinModelEntry {
  return {
    modelId: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    status: "ACTIVE",
    features: ["UNIFY_CHAT_WITH_AI"],
    modality: { INPUT: ["text", "image"], OUTPUT: ["text"] },
    creditMetadata: {},
    ...overrides,
  };
}

const sets = {
  chat: new Set(["gpt-4o"]),
  vision: new Set(["gpt-4o"]),
  codeInterpreter: new Set<string>(),
};

describe("buildModelObject", () => {
  it("produces an OpenAI-shaped model object", () => {
    const model = buildModelObject(entry(), FETCHED_AT, sets);
    expect(model.id).toBe("gpt-4o");
    expect(model.object).toBe("model");
    expect(model.owned_by).toBe("openai");
    expect(model.root).toBe("gpt-4o");
    expect(model.created).toBe(Math.floor(FETCHED_AT / 1000));
  });

  it("derives capabilities from the registry sets", () => {
    const model = buildModelObject(entry(), FETCHED_AT, sets);
    expect(model.capabilities).toEqual({
      vision: true,
      code_interpreter: false,
      retrieval: true,
    });
  });

  it("falls back to 1min-ai when the provider is missing", () => {
    const model = buildModelObject(
      entry({ modelId: "mystery", provider: "" }),
      FETCHED_AT,
      sets,
    );
    expect(model.owned_by).toBe("1min-ai");
    expect(model.capabilities).toEqual({
      vision: false,
      code_interpreter: false,
      retrieval: false,
    });
  });
});
