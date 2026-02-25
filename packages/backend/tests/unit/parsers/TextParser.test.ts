import { describe, expect, it } from "vitest";
import { TextParser } from "../../../src/parsers/TextParser.js";

describe("TextParser", () => {
  it("returns plain text content and metadata", async () => {
    const parser = new TextParser();
    const result = await parser.parse(Buffer.from("hello graphen\nsecond line", "utf8"));

    expect(result.text).toBe("hello graphen\nsecond line");
    expect(result.metadata.wordCount).toBe(4);
    expect(result.metadata.lineCount).toBe(2);
  });
});
