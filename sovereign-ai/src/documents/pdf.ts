import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface DocumentToolsConfig {
  ocrCommand?: string;
  maxPages?: number;
  maxCharacters?: number;
}

export interface DocumentPage {
  page: number;
  text: string;
  hasText: boolean;
}

export interface DocumentInspection {
  path: string;
  format: "pdf" | "text";
  pageCount: number;
  hasExtractableText: boolean;
  pages: DocumentPage[];
}

export interface DocumentTextResult {
  path: string;
  pages: DocumentPage[];
  truncated: boolean;
}

export interface DocumentTable {
  page: number;
  headers: string[];
  rows: string[][];
}

const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_CHARACTERS = 50_000;

function jsonValue<T>(value: T): JsonValue {
  return value as JsonValue;
}

function configOf(config: DocumentToolsConfig): Required<DocumentToolsConfig> {
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  const maxCharacters = config.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0)
    throw new TypeError("document maxPages must be positive");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0)
    throw new TypeError("document maxCharacters must be positive");
  return {
    ocrCommand: config.ocrCommand ?? "tesseract {input} stdout",
    maxPages,
    maxCharacters,
  };
}

function pdfPages(data: Buffer, maxPages: number): DocumentPage[] {
  const raw = data.toString("latin1");
  const pageParts = raw.split(/\/Type\s*\/Page\b/iu).slice(1, maxPages + 1);
  return pageParts.map((part, index) => {
    const text = [...part.matchAll(/\(([^()]*)\)\s*T[Jj]/g)]
      .map((match) => match[1] ?? "")
      .join(" ")
      .replace(/\\([\\()])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return { page: index + 1, text, hasText: text.length > 0 };
  });
}

async function readPages(
  path: string,
  config: Required<DocumentToolsConfig>,
): Promise<{ format: "pdf" | "text"; pages: DocumentPage[] }> {
  const data = await readFile(path);
  if (
    extname(path).toLowerCase() === ".pdf" ||
    data.subarray(0, 5).toString("latin1") === "%PDF-"
  ) {
    return { format: "pdf", pages: pdfPages(data, config.maxPages) };
  }
  return {
    format: "text",
    pages: [{ page: 1, text: data.toString("utf8"), hasText: data.length > 0 }],
  };
}

function boundedPages(
  pages: DocumentPage[],
  maxCharacters: number,
): { pages: DocumentPage[]; truncated: boolean } {
  let remaining = maxCharacters;
  let truncated = false;
  const bounded = pages.map((page) => {
    if (remaining <= 0) {
      truncated = true;
      return { ...page, text: "", hasText: false };
    }
    const text = page.text.slice(0, remaining);
    if (text.length < page.text.length) truncated = true;
    remaining -= text.length;
    return { ...page, text, hasText: text.length > 0 };
  });
  return { pages: bounded, truncated };
}

function runLocalOcr(command: string, input: string): Promise<string> {
  const parts =
    command
      .replaceAll("{input}", JSON.stringify(input))
      .match(/"[^"\\]*(?:\\.[^"\\]*)*"|\S+/g) ?? [];
  if (parts.length === 0)
    return Promise.reject(new Error("OCR command must not be empty"));
  const [executable, ...args] = parts.map((part) =>
    part.startsWith('"') ? (JSON.parse(part) as string) : part,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(executable!, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(
            new Error(`OCR command failed (${code}): ${stderr.slice(0, 300)}`),
          ),
    );
  });
}

export function createDocumentTools(config: DocumentToolsConfig = {}) {
  const resolved = configOf(config);
  return {
    async inspect(path: string): Promise<DocumentInspection> {
      const document = await readPages(path, resolved);
      return {
        path,
        format: document.format,
        pageCount: document.pages.length,
        hasExtractableText: document.pages.some((page) => page.hasText),
        pages: boundedPages(document.pages, resolved.maxCharacters).pages,
      };
    },
    async extractText(path: string): Promise<DocumentTextResult> {
      const document = await readPages(path, resolved);
      const bounded = boundedPages(document.pages, resolved.maxCharacters);
      return { path, pages: bounded.pages, truncated: bounded.truncated };
    },
    async ocr(path: string): Promise<DocumentTextResult> {
      const document = await readPages(path, resolved);
      if (document.pages.some((page) => page.hasText))
        return {
          path,
          pages: boundedPages(document.pages, resolved.maxCharacters).pages,
          truncated: false,
        };
      const text = await runLocalOcr(resolved.ocrCommand, path);
      const bounded = boundedPages(
        [{ page: 1, text, hasText: text.length > 0 }],
        resolved.maxCharacters,
      );
      return { path, pages: bounded.pages, truncated: bounded.truncated };
    },
    async tables(
      path: string,
    ): Promise<{ path: string; tables: DocumentTable[] }> {
      const text = await this.extractText(path);
      const tables: DocumentTable[] = [];
      for (const page of text.pages) {
        const lines = page.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.includes("|") || line.includes("\t"));
        if (lines.length < 2) continue;
        const rows = lines.map((line) =>
          line
            .split(line.includes("|") ? "|" : "\t")
            .map((cell) => cell.trim())
            .filter(Boolean),
        );
        const headers = rows.shift() ?? [];
        if (
          headers.length > 1 &&
          rows.some((row) => row.length === headers.length)
        )
          tables.push({ page: page.page, headers, rows });
      }
      return { path, tables };
    },
  };
}

export function registerDocumentTools(
  ctx: Context,
  config: DocumentToolsConfig = {},
): void {
  const tools = createDocumentTools(config);
  ctx.tools.register(
    defineTool({
      name: "inspect_document",
      description:
        "Inspect a local PDF or text document and report page count and extractable text status.",
      parameters: { path: { type: "string", required: true } },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return jsonValue(await tools.inspect(args.path));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "extract_document_text",
      description:
        "Extract concise, page-numbered text from a local PDF or text document.",
      parameters: { path: { type: "string", required: true } },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return jsonValue(await tools.extractText(args.path));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "ocr_document",
      description:
        "Run the configured offline OCR engine on a scanned local PDF when text extraction is unavailable.",
      parameters: { path: { type: "string", required: true } },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return jsonValue(await tools.ocr(args.path));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "extract_tables",
      description:
        "Extract simple pipe- or tab-delimited tables from a local document with page numbers.",
      parameters: { path: { type: "string", required: true } },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(args) {
        return jsonValue(await tools.tables(args.path));
      },
    }),
  );
}
