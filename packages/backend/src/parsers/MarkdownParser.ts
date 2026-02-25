import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { countWords, type DocumentParser, type ParsedDocumentResult } from "./types.js";

export class MarkdownParser implements DocumentParser {
  async parse(buffer: Buffer): Promise<ParsedDocumentResult> {
    const source = buffer.toString("utf8");
    const tree = unified().use(remarkParse).parse(source);
    const fragments: string[] = [];

    visit(tree, (node) => {
      if (typeof (node as { value?: unknown }).value === "string") {
        const value = ((node as { value: string }).value ?? "").trim();
        if (value.length > 0) {
          fragments.push(value);
        }
      }
    });

    const text = fragments.join("\n");
    return {
      text,
      metadata: {
        wordCount: countWords(text),
        lineCount: source.length > 0 ? source.split(/\r?\n/).length : 0
      }
    };
  }
}
