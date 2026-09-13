import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { SovereigntyMonitor } from "../sovereignty/monitor.js";

export interface RagConfig {
  knowledgeBaseDirectory: string;
  databasePath: string;
  embeddingBaseUrl: string;
  embeddingModel: string;
  chunkSize?: number;
  chunkOverlap?: number;
  resultLimit?: number;
  requestMonitor?: SovereigntyMonitor;
}

export interface RagSource {
  filename: string;
  page?: number;
  chunk: number;
  score: number;
}

export interface RagResult {
  text: string;
  source: RagSource;
}

export interface RagService {
  index(): Promise<number>;
  search(query: string, limit?: number): Promise<RagResult[]>;
}

interface ChunkRecord {
  filename: string;
  page?: number;
  chunk: number;
  text: string;
  embedding: number[];
}

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 120;
const DEFAULT_RESULT_LIMIT = 5;

type ResolvedRagConfig = Omit<Required<RagConfig>, "requestMonitor"> &
  Pick<RagConfig, "requestMonitor">;

function validateConfig(config: RagConfig): ResolvedRagConfig {
  const knowledgeBaseDirectory = resolve(config.knowledgeBaseDirectory);
  const databasePath = resolve(config.databasePath);
  let url: URL;
  try {
    url = new URL(config.embeddingBaseUrl);
  } catch {
    throw new TypeError("RAG embeddingBaseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("RAG embeddingBaseUrl must use http or https");
  }
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = config.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const resultLimit = config.resultLimit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new TypeError("RAG chunkSize must be positive");
  if (
    !Number.isSafeInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    throw new TypeError(
      "RAG chunkOverlap must be non-negative and smaller than chunkSize",
    );
  }
  if (!Number.isSafeInteger(resultLimit) || resultLimit <= 0)
    throw new TypeError("RAG resultLimit must be positive");
  if (config.embeddingModel.trim().length === 0)
    throw new TypeError("RAG embeddingModel must not be empty");
  return {
    knowledgeBaseDirectory,
    databasePath,
    embeddingBaseUrl: url.toString().replace(/\/$/, ""),
    embeddingModel: config.embeddingModel,
    chunkSize,
    chunkOverlap,
    resultLimit,
  };
}

function extractPdf(buffer: Buffer): string[] {
  const raw = buffer.toString("latin1");
  return [...raw.matchAll(/BT([\s\S]*?)ET/g)]
    .map((match) =>
      [...(match[1] ?? "").matchAll(/\(([^()]*)\)\s*T[Jj]/g)]
        .map((part) => part[1] ?? "")
        .join(" ")
        .replace(/\\([\\()])/g, "$1")
        .trim(),
    )
    .filter(Boolean);
}

async function extractDocuments(
  directory: string,
): Promise<Array<{ filename: string; page?: number; text: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const documents: Array<{ filename: string; page?: number; text: string }> =
    [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    const path = join(directory, filename);
    if (filename.toLowerCase().endsWith(".txt")) {
      documents.push({ filename, text: await readFile(path, "utf8") });
    } else if (filename.toLowerCase().endsWith(".pdf")) {
      const pages = extractPdf(await readFile(path));
      pages.forEach((text, index) =>
        documents.push({ filename, page: index + 1, text }),
      );
    }
  }
  return documents;
}

function chunkText(text: string, size: number, overlap: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    const chunk = normalized.slice(start, start + size).trim();
    if (chunk) chunks.push(chunk);
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

async function embed(
  baseUrl: string,
  model: string,
  input: string,
  monitor?: SovereigntyMonitor,
): Promise<number[]> {
  monitor?.request(`${baseUrl}/embeddings`, "embedding");
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok)
    throw new Error(
      `local embedding request failed with HTTP ${response.status}`,
    );
  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vector = body.data?.[0]?.embedding;
  if (
    !Array.isArray(vector) ||
    vector.length === 0 ||
    vector.some((value) => typeof value !== "number")
  ) {
    throw new Error(
      "local embedding response did not contain a numeric vector",
    );
  }
  return vector;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude === 0 || rightMagnitude === 0
    ? 0
    : dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE IF NOT EXISTS rag_chunks (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    page INTEGER,
    chunk INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding TEXT NOT NULL
  )`);
  return database;
}

export function createRagService(rawConfig: RagConfig): RagService {
  const config = validateConfig(rawConfig);
  const database = openDatabase(config.databasePath);
  let indexed = false;
  let indexing: Promise<number> | undefined;
  const index = async (): Promise<number> => {
    if (indexing !== undefined) return indexing;
    indexing = (async () => {
      const documents = await extractDocuments(config.knowledgeBaseDirectory);
      const records: ChunkRecord[] = [];
      for (const document of documents) {
        const chunks = chunkText(
          document.text,
          config.chunkSize,
          config.chunkOverlap,
        );
        for (const [chunk, text] of chunks.entries()) {
          records.push({
            filename: document.filename,
            ...(document.page === undefined ? {} : { page: document.page }),
            chunk,
            text,
            embedding: await embed(
              config.embeddingBaseUrl,
              config.embeddingModel,
              text,
              config.requestMonitor,
            ),
          });
        }
      }
      database.exec("DELETE FROM rag_chunks");
      const insert = database.prepare(
        "INSERT INTO rag_chunks (filename, page, chunk, text, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      for (const record of records)
        insert.run(
          record.filename,
          record.page ?? null,
          record.chunk,
          record.text,
          JSON.stringify(record.embedding),
        );
      indexed = true;
      return records.length;
    })();
    try {
      return await indexing;
    } finally {
      indexing = undefined;
    }
  };
  return {
    index,
    async search(query, limit = config.resultLimit) {
      if (query.trim().length === 0) return [];
      if (!indexed) await index();
      const queryEmbedding = await embed(
        config.embeddingBaseUrl,
        config.embeddingModel,
        query,
        config.requestMonitor,
      );
      const rows = database
        .prepare(
          "SELECT filename, page, chunk, text, embedding FROM rag_chunks",
        )
        .all() as Array<Record<string, unknown>>;
      return rows
        .map((row) => ({
          text: String(row.text),
          source: {
            filename: String(row.filename),
            ...(row.page === null ? {} : { page: Number(row.page) }),
            chunk: Number(row.chunk),
            score: cosine(
              queryEmbedding,
              JSON.parse(String(row.embedding)) as number[],
            ),
          },
        }))
        .sort((left, right) => right.source.score - left.source.score)
        .slice(0, limit);
    },
  };
}

export function registerRagTool(ctx: Context, service: RagService): void {
  ctx.tools.register(
    defineTool({
      name: "search_knowledge_base",
      description:
        "Search the configured local knowledge base and return concise relevant excerpts with source metadata.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Natural-language question or search query.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: { type: "string", required: true },
                  filename: { type: "string", required: true },
                  page: { type: "integer" },
                  chunk: { type: "integer", required: true },
                  score: { type: "number", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              value.results
                .map(
                  (result) =>
                    `${result.filename}${result.page === undefined ? "" : ` page ${result.page}`} chunk ${result.chunk} score ${result.score.toFixed(3)}\n${result.text}`,
                )
                .join("\n\n") || "No matching local knowledge-base results.",
          },
        ],
      },
      async execute(args) {
        const results = await service.search(args.query);
        return {
          results: results.map((result) => ({
            text: result.text,
            ...result.source,
          })),
        };
      },
    }),
  );
}

export async function validateKnowledgeBaseDirectory(
  directory: string,
): Promise<void> {
  const info = await stat(directory);
  if (!info.isDirectory())
    throw new TypeError("RAG knowledgeBaseDirectory must be a directory");
}
