import { describe, expect, it } from "vitest";
import { parseModelName } from "../src/utils/model-parser";

describe("parseModelName", () => {
  it("parses a plain model name", () => {
    expect(parseModelName("open-mistral-nemo")).toEqual({
      originalModel: "open-mistral-nemo",
      hasOnlineSuffix: false,
      isValid: true,
    });
  });

  it("strips the :online suffix", () => {
    expect(parseModelName("gpt-4o:online")).toEqual({
      originalModel: "gpt-4o",
      hasOnlineSuffix: true,
      isValid: true,
    });
  });

  it("keeps a model id that contains a slash", () => {
    expect(parseModelName("black-forest-labs/flux-dev").originalModel).toBe(
      "black-forest-labs/flux-dev",
    );
  });

  it("passes through a model id containing a colon", () => {
    // ":online" is a convention this relay adds, not a reserved character.
    // Rejecting every colon would refuse a legitimate upstream id.
    const result = parseModelName("vendor:model-v2");
    expect(result.isValid).toBe(true);
    expect(result.originalModel).toBe("vendor:model-v2");
    expect(result.hasOnlineSuffix).toBe(false);
  });

  it("leaves a mistyped suffix to model validation", () => {
    const result = parseModelName("gpt-4o:onlien");
    expect(result.isValid).toBe(true);
    expect(result.originalModel).toBe("gpt-4o:onlien");
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelName("  gpt-4o:online  ").originalModel).toBe("gpt-4o");
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(parseModelName("").isValid).toBe(false);
    expect(parseModelName("   ").isValid).toBe(false);
    expect(parseModelName("   ").originalModel).toBe("");
  });

  it("rejects a bare :online with no model", () => {
    const result = parseModelName(":online");
    expect(result.isValid).toBe(false);
    expect(result.hasOnlineSuffix).toBe(true);
  });
});
