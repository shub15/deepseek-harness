# Sovereign AI Profile

This profile composes the local model provider, capability router, local RAG, PDF/document tools, office artifact tools, sovereignty monitor, compact audit trace, and Web UI panel. It has no cloud provider route, no external embedding API, and no telemetry or remote reporting.

## Setup

From the repository root, install the local bundle and the Web surface in one command:

```powershell
pnpm dsh plugin --profile sovereign add ./sovereign
```

Create `sovereign-kb`, `sovereign-data`, and `sovereign-output` in the profile directory. Copy local model and path values from [`config/local-models.yml`](config/local-models.yml) and [`config/paths.yml`](config/paths.yml) when changing the demo endpoints. Install a local OCR executable named `tesseract` if scanned PDFs are required.

## Run

Start the composed Web profile:

```powershell
pnpm dsh --profile sovereign
```

The local model services must listen on ports 8000, 8001, and optionally 8002. The profile starts no model, embedding, OCR, or cloud service itself; those services remain local deployment prerequisites.

## Demo Workflows

### 1. Inspection PDF -> RAG -> approval note DOCX

Place an inspection PDF in `sovereign-kb`, use `extract_document_text` or `ocr_document` when it is scanned, call `search_knowledge_base`, and ask the local model to create an approval note with `create_docx`. The resulting file is written under `sovereign-output`.

### 2. Coding task -> sandbox -> tests

Submit a coding request. The router selects the local coding endpoint; use the existing DSH sandbox/shell tools to edit and test the workspace. The audit trace records the request, model route, tool calls, and results locally.

### 3. Image/P&ID -> vision model -> answer/Excel

Attach an image or P&ID and ask for a visual answer. With the vision endpoint enabled, routing selects `sovereign-local-vision`; use `create_xlsx` to write a local inspection table. P&ID-specific detection is not included in this prototype.

## Verify Network Isolation

Run `sovereignty-status` and inspect the Web panel. The monitor reports application-observed Sovereign requests, allowed local endpoints, blocked external attempts, and whether calls reached local model routes. An external URL passed through a Sovereign provider is denied by default and recorded in `sovereign-data/audit.jsonl`.

These counters prove only application-observed plugin activity. They do not prove system-wide network isolation. Verify OS/firewall isolation separately with the host firewall or sandbox policy and an OS-level network test; the Sovereign monitor reports that OS enforcement is outside its scope.
