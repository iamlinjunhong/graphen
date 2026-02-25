import { describe, expect, it } from "vitest";
import { MarkdownParser } from "../../../src/parsers/MarkdownParser.js";

describe("MarkdownParser", () => {
  it("extracts readable text from markdown content", async () => {
    const parser = new MarkdownParser();
    const markdown = `
# Graphen

Graphen **builds** a _GraphRAG_ system.

\`\`\`ts
const enabled = true;
\`\`\`
`;

    const result = await parser.parse(Buffer.from(markdown, "utf8"));

    expect(result.text).toContain("Graphen");
    expect(result.text).toContain("builds");
    expect(result.text).toContain("const enabled = true;");
    expect(result.metadata.wordCount).toBeGreaterThan(4);
    expect(result.metadata.lineCount).toBeGreaterThan(3);
  });
});
