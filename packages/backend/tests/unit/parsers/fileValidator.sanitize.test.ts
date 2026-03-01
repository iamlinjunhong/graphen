import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { sanitizeFilename } from "../../../src/parsers/fileValidator.js";

/**
 * Bug condition: filename contains non-ASCII Unicode letters/digits.
 * The current regex /[^\w.-]/g strips these characters because \w only matches [a-zA-Z0-9_].
 */
function isBugCondition(filename: string): boolean {
  const base = filename.split("/").pop()?.split("\\").pop() ?? filename;
  return [...base].some(
    (c) => /[\p{L}\p{N}]/u.test(c) && !/[a-zA-Z0-9_]/.test(c)
  );
}

const validExtensions = [".pdf", ".md", ".txt"] as const;

/**
 * Arbitrary that generates filenames containing Unicode letters/digits
 * mixed with ASCII characters and a valid extension.
 */
const unicodeFilenameArb = fc
  .tuple(
    // Generate a mix of ASCII and Unicode characters for the stem
    fc.array(
      fc.oneof(
        // ASCII alphanumeric + underscore
        fc.mapToConstant(
          { num: 26, build: (v) => String.fromCharCode(97 + v) },  // a-z
          { num: 26, build: (v) => String.fromCharCode(65 + v) },  // A-Z
          { num: 10, build: (v) => String.fromCharCode(48 + v) },  // 0-9
          { num: 1, build: () => "_" }
        ),
        // CJK Unified Ideographs (Chinese characters)
        fc.integer({ min: 0x4e00, max: 0x9fff }).map((cp) => String.fromCodePoint(cp)),
        // Katakana (Japanese)
        fc.integer({ min: 0x30a0, max: 0x30ff }).map((cp) => String.fromCodePoint(cp)),
        // Hangul Syllables (Korean)
        fc.integer({ min: 0xac00, max: 0xd7af }).map((cp) => String.fromCodePoint(cp)),
        // Latin Extended (accented characters)
        fc.integer({ min: 0x00c0, max: 0x024f }).map((cp) => String.fromCodePoint(cp))
      ),
      { minLength: 2, maxLength: 20 }
    ),
    fc.constantFrom(...validExtensions)
  )
  .map(([chars, ext]) => chars.join("") + ext)
  .filter(isBugCondition);

describe("sanitizeFilename – Bug Condition Exploration (Property 1: Fault Condition)", () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 2.1, 2.2**
   *
   * Property: For any filename containing non-ASCII Unicode letters/digits,
   * sanitizeFilename should preserve all Unicode letters and digits from the input.
   *
   * EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
   */
  it("should preserve all Unicode letters and digits in the filename", () => {
    fc.assert(
      fc.property(unicodeFilenameArb, (filename) => {
        const result = sanitizeFilename(filename);

        // Extract all Unicode letters and digits from the input (excluding extension)
        const ext = filename.slice(filename.lastIndexOf("."));
        const stem = filename.slice(0, filename.lastIndexOf("."));
        const unicodeChars = [...stem].filter((c) => /[\p{L}\p{N}]/u.test(c));

        // Every Unicode letter/digit from the input must appear in the result
        for (const ch of unicodeChars) {
          expect(result).toContain(ch);
        }

        // The extension should be preserved
        expect(result.endsWith(ext)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // Concrete examples from the spec
  describe("concrete examples", () => {
    it('sanitizeFilename("01_合同自由_民法典第465条.md") should equal "01_合同自由_民法典第465条.md"', () => {
      expect(sanitizeFilename("01_合同自由_民法典第465条.md")).toBe(
        "01_合同自由_民法典第465条.md"
      );
    });

    it('sanitizeFilename("レポート_2024.pdf") should equal "レポート_2024.pdf"', () => {
      expect(sanitizeFilename("レポート_2024.pdf")).toBe("レポート_2024.pdf");
    });

    it('sanitizeFilename("café_résumé.txt") should equal "café_résumé.txt"', () => {
      expect(sanitizeFilename("café_résumé.txt")).toBe("café_résumé.txt");
    });
  });
});


// --- Property 1b: Latin1→UTF-8 Recovery (simulating multer behavior) ---

describe("sanitizeFilename – Latin1 mojibake recovery (multer simulation)", () => {
  /**
   * Multer decodes multipart filenames as latin1 by default.
   * UTF-8 bytes get misinterpreted, producing mojibake.
   * sanitizeFilename should recover the original UTF-8 string.
   */
  function simulateMulterLatin1(utf8Filename: string): string {
    // Encode as UTF-8, then decode each byte as latin1 (what multer does)
    const buf = Buffer.from(utf8Filename, "utf8");
    return buf.toString("latin1");
  }

  it("should recover Chinese filename from multer latin1 mojibake", () => {
    const original = "01_合同自由_民法典第465条.md";
    const mojibake = simulateMulterLatin1(original);
    expect(sanitizeFilename(mojibake)).toBe(original);
  });

  it("should recover Japanese filename from multer latin1 mojibake", () => {
    const original = "レポート_2024.pdf";
    const mojibake = simulateMulterLatin1(original);
    expect(sanitizeFilename(mojibake)).toBe(original);
  });

  it("should recover mixed Unicode filename from multer latin1 mojibake", () => {
    const original = "文档_document_ドキュメント.md";
    const mojibake = simulateMulterLatin1(original);
    expect(sanitizeFilename(mojibake)).toBe(original);
  });

  it("should not corrupt pure ASCII filenames during recovery", () => {
    expect(sanitizeFilename("transaction_network.md")).toBe("transaction_network.md");
  });
});

// --- Property 2: Preservation Tests ---

/**
 * The original regex used in unfixed sanitizeFilename.
 * Used as a reference oracle for preservation property testing.
 */
function originalSanitize(filename: string): string {
  const { basename } = require("node:path");
  const cleanBase = basename(filename).replace(/[^\w.-]/g, "_");
  return cleanBase.length > 0 ? cleanBase : "file";
}

/**
 * Arbitrary that generates ASCII-only filenames using characters from
 * [a-zA-Z0-9_.@#$%^&!~ -] plus a valid extension.
 * These filenames do NOT trigger the bug condition.
 */
const asciiFilenameArb = fc
  .tuple(
    fc.array(
      fc.mapToConstant(
        { num: 26, build: (v) => String.fromCharCode(97 + v) },  // a-z
        { num: 26, build: (v) => String.fromCharCode(65 + v) },  // A-Z
        { num: 10, build: (v) => String.fromCharCode(48 + v) },  // 0-9
        { num: 1, build: () => "_" },
        { num: 1, build: () => "." },
        { num: 1, build: () => "@" },
        { num: 1, build: () => "#" },
        { num: 1, build: () => "$" },
        { num: 1, build: () => "%" },
        { num: 1, build: () => "^" },
        { num: 1, build: () => "&" },
        { num: 1, build: () => "!" },
        { num: 1, build: () => "~" },
        { num: 1, build: () => " " },
        { num: 1, build: () => "-" }
      ),
      { minLength: 1, maxLength: 20 }
    ),
    fc.constantFrom(...validExtensions)
  )
  .map(([chars, ext]) => chars.join("") + ext)
  .filter((f) => !isBugCondition(f));

describe("sanitizeFilename – Preservation (Property 2: ASCII filenames behavior unchanged)", () => {
  /**
   * **Validates: Requirements 3.1, 3.2, 3.3**
   *
   * Observation-first: verify concrete behaviors on unfixed code.
   */
  describe("observed behaviors on unfixed code", () => {
    it('sanitizeFilename("transaction_network.md") returns "transaction_network.md"', () => {
      expect(sanitizeFilename("transaction_network.md")).toBe("transaction_network.md");
    });

    it('sanitizeFilename("../../etc/passwd") returns "passwd" (path traversal stripped)', () => {
      expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    });

    it('sanitizeFilename("file@name#1.txt") returns "file_name_1.txt" (special chars replaced)', () => {
      expect(sanitizeFilename("file@name#1.txt")).toBe("file_name_1.txt");
    });

    it('sanitizeFilename("") returns "file" (empty fallback)', () => {
      expect(sanitizeFilename("")).toBe("file");
    });

    it('sanitizeFilename("weird name?.md") returns "weird_name_.md"', () => {
      expect(sanitizeFilename("weird name?.md")).toBe("weird_name_.md");
    });
  });

  /**
   * **Validates: Requirements 3.1, 3.2, 3.3**
   *
   * Property: For any ASCII-only filename (non-bug-condition input),
   * sanitizeFilename produces the same result as the original regex /[^\w.-]/g.
   * This ensures the fix does not change behavior for non-Unicode filenames.
   */
  it("should produce identical output to original regex for all ASCII-only filenames", () => {
    fc.assert(
      fc.property(asciiFilenameArb, (filename) => {
        const actual = sanitizeFilename(filename);
        const expected = originalSanitize(filename);
        expect(actual).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });
});
