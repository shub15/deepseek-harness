import { mkdir, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

export interface ArtifactToolsConfig {
  /** Workspace root used to constrain generated paths. Defaults to cwd. */
  workspaceDirectory?: string;
  /** Output directory relative to the workspace root. Defaults to output. */
  outputDirectory?: string;
}

export interface ArtifactMetadata {
  path: string;
  filename: string;
  format: "docx" | "xlsx" | "pptx";
  bytes: number;
}

export interface DocumentTableInput {
  headers?: string[];
  rows: string[][];
}

export interface CreateDocxInput {
  filename: string;
  title?: string;
  headings?: string[];
  paragraphs?: string[];
  tables?: DocumentTableInput[];
}

export interface SpreadsheetSheetInput {
  name: string;
  cells: Record<string, string | number | boolean | null>;
  formulas?: Record<string, string>;
}

export interface CreateXlsxInput {
  filename: string;
  sheets: SpreadsheetSheetInput[];
  chart?: { sheet: string; range: string; title?: string };
}

export interface PresentationTableInput {
  headers?: string[];
  rows: string[][];
}

export interface PresentationSlideInput {
  title?: string;
  text?: string;
  tables?: PresentationTableInput[];
}

export interface CreatePptxInput {
  filename: string;
  title?: string;
  slides: PresentationSlideInput[];
}

interface ArtifactPaths {
  workspace: string;
  output: string;
}

function resolvePaths(config: ArtifactToolsConfig): ArtifactPaths {
  const workspace = resolve(config.workspaceDirectory ?? process.cwd());
  const output = resolve(workspace, config.outputDirectory ?? "output");
  const outside =
    relative(workspace, output).startsWith("..") ||
    isAbsolute(relative(workspace, output));
  if (outside)
    throw new TypeError(
      "artifact outputDirectory must remain inside workspaceDirectory",
    );
  return { workspace, output };
}

function safeOutputPath(
  paths: ArtifactPaths,
  filename: string,
  extension: string,
): string {
  if (filename.trim().length === 0)
    throw new TypeError("artifact filename must not be empty");
  const leaf = filename.toLowerCase().endsWith(extension)
    ? filename
    : `${filename}${extension}`;
  const outputPath = resolve(paths.output, leaf);
  const relativeOutput = relative(paths.output, outputPath);
  if (relativeOutput.startsWith("..") || isAbsolute(relativeOutput)) {
    throw new TypeError(
      "artifact filename must remain inside the configured output directory",
    );
  }
  return outputPath;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

function jsonObject(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

interface PptxSlide {
  addText(text: string, options: Record<string, unknown>): void;
  addTable(rows: string[][], options: Record<string, unknown>): void;
}

interface PptxPresentation {
  layout: string;
  addSlide(): PptxSlide;
  writeFile(options: { fileName: string }): Promise<void>;
}

interface PptxConstructor {
  new (): PptxPresentation;
}
async function metadata(
  path: string,
  format: ArtifactMetadata["format"],
): Promise<ArtifactMetadata> {
  const info = await stat(path);
  return {
    path,
    filename: path
      .slice(path.lastIndexOf("\\") + 1)
      .slice(path.lastIndexOf("/") + 1),
    format,
    bytes: info.size,
  };
}

function docxTable(input: DocumentTableInput): Table {
  const rows =
    input.headers === undefined ? input.rows : [input.headers, ...input.rows];
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                children: [new Paragraph({ children: [new TextRun(cell)] })],
              }),
          ),
        }),
    ),
  });
}

export function createArtifactTools(config: ArtifactToolsConfig = {}) {
  const paths = resolvePaths(config);
  return {
    async createDocx(input: CreateDocxInput): Promise<ArtifactMetadata> {
      const path = safeOutputPath(paths, input.filename, ".docx");
      await mkdir(paths.output, { recursive: true });
      const children: Array<Paragraph | Table> = [];
      if (input.title !== undefined)
        children.push(
          new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
        );
      for (const heading of input.headings ?? [])
        children.push(
          new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }),
        );
      for (const paragraph of input.paragraphs ?? [])
        children.push(new Paragraph({ text: paragraph }));
      for (const table of input.tables ?? []) children.push(docxTable(table));
      const document = new Document({ sections: [{ children }] });
      await writeFile(path, await Packer.toBuffer(document));
      return metadata(path, "docx");
    },
    async createXlsx(input: CreateXlsxInput): Promise<ArtifactMetadata> {
      const path = safeOutputPath(paths, input.filename, ".xlsx");
      await mkdir(paths.output, { recursive: true });
      const workbook = new ExcelJS.Workbook();
      for (const sheetInput of input.sheets) {
        const sheet = workbook.addWorksheet(sheetInput.name);
        for (const [address, value] of Object.entries(sheetInput.cells))
          sheet.getCell(address).value = value;
        for (const [address, formula] of Object.entries(
          sheetInput.formulas ?? {},
        ))
          sheet.getCell(address).value = { formula };
        sheet.eachRow((row) =>
          row.eachCell((cell) => {
            cell.alignment = { vertical: "top", wrapText: true };
            cell.border = {
              bottom: { style: "thin", color: { argb: "FFD9E2EC" } },
            };
          }),
        );
      }
      // ExcelJS does not provide a chart API in this runtime; the workbook
      // remains valid and the requested chart is intentionally omitted.
      await workbook.xlsx.writeFile(path);
      return metadata(path, "xlsx");
    },
    async createPptx(input: CreatePptxInput): Promise<ArtifactMetadata> {
      const path = safeOutputPath(paths, input.filename, ".pptx");
      await mkdir(paths.output, { recursive: true });
      const PptxConstructor = PptxGenJS as unknown as PptxConstructor;
      const presentation = new PptxConstructor();
      presentation.layout = "LAYOUT_WIDE";
      for (const [index, slideInput] of input.slides.entries()) {
        const slide = presentation.addSlide();
        if (index === 0 && input.title !== undefined)
          slide.addText(input.title, {
            x: 0.5,
            y: 0.3,
            w: 12,
            h: 0.6,
            fontSize: 24,
            bold: true,
          });
        if (slideInput.title !== undefined)
          slide.addText(slideInput.title, {
            x: 0.5,
            y: 1,
            w: 12,
            h: 0.5,
            fontSize: 20,
            bold: true,
          });
        if (slideInput.text !== undefined)
          slide.addText(slideInput.text, {
            x: 0.7,
            y: 1.7,
            w: 11.5,
            h: 3.5,
            fontSize: 16,
            breakLine: false,
            valign: "top",
          });
        for (const table of slideInput.tables ?? [])
          slide.addTable(
            [
              ...(table.headers === undefined ? [] : [table.headers]),
              ...table.rows,
            ],
            {
              x: 0.7,
              y: 2,
              w: 11,
              h: 2.5,
              fontSize: 12,
              border: { type: "solid", color: "B8C4D0", pt: 1 },
            },
          );
      }
      await presentation.writeFile({ fileName: path });
      return metadata(path, "pptx");
    },
  };
}

export function registerArtifactTools(
  ctx: Context,
  config: ArtifactToolsConfig = {},
): void {
  const tools = createArtifactTools(config);
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
  ctx.tools.register(
    defineTool({
      name: "create_docx",
      description:
        "Create a local DOCX file in the configured workspace output directory.",
      parameters: {
        filename: { type: "string", required: true },
        title: { type: "string" },
        headings: { type: "array", items: { type: "string" } },
        paragraphs: { type: "array", items: { type: "string" } },
        tables: { type: "json" },
      },
      output,
      async execute(args) {
        return jsonObject(await tools.createDocx(args as unknown as CreateDocxInput));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "create_xlsx",
      description:
        "Create a local XLSX workbook in the configured workspace output directory.",
      parameters: {
        filename: { type: "string", required: true },
        sheets: { type: "json", required: true },
        chart: { type: "json" },
      },
      output,
      async execute(args) {
        return jsonObject(await tools.createXlsx(args as unknown as CreateXlsxInput));
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: "create_pptx",
      description:
        "Create a local PPTX presentation in the configured workspace output directory.",
      parameters: {
        filename: { type: "string", required: true },
        title: { type: "string" },
        slides: { type: "json", required: true },
      },
      output,
      async execute(args) {
        return jsonObject(await tools.createPptx(args as unknown as CreatePptxInput));
      },
    }),
  );
}
