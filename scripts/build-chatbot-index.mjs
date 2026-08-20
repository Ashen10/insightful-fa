// Build the Azure AI Search index for the website chatbot.
//
// Reads the curated knowledge corpus in content/chatbot-knowledge/*.md, splits it
// into chunks, embeds each chunk with the Azure OpenAI "embed" deployment, and
// uploads the vectors to an Azure AI Search index. Re-run any time the corpus
// changes:  node scripts/build-chatbot-index.mjs
//
// Requires .env.local (gitignored) with the AZURE_OPENAI_* and AZURE_SEARCH_*
// variables. No npm dependencies — uses Node 18+ global fetch.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// --- tiny .env.local loader (no dotenv dependency) -------------------------
function loadEnv() {
  try {
    const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* env may be provided by the shell instead */
  }
}
loadEnv();

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_VERSION = "2024-10-21",
  AZURE_OPENAI_EMBED_DEPLOYMENT = "embed",
  AZURE_SEARCH_ENDPOINT,
  AZURE_SEARCH_ADMIN_KEY,
  AZURE_SEARCH_INDEX = "insightful-content",
} = process.env;

for (const [k, v] of Object.entries({
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_SEARCH_ENDPOINT,
  AZURE_SEARCH_ADMIN_KEY,
})) {
  if (!v) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const EMBED_DIMS = 1536; // text-embedding-3-small
const SEARCH_API = "2024-07-01";

// --- chunk the corpus ------------------------------------------------------
function chunkMarkdown(text, maxChars = 1200) {
  const lines = text.split("\n");
  let docTitle = "";
  const paras = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      paras.push(buf.join("\n").trim());
      buf = [];
    }
  };
  for (const line of lines) {
    if (line.startsWith("# ") && !docTitle) docTitle = line.replace(/^#\s+/, "").trim();
    if (line.trim() === "") flush();
    else buf.push(line);
  }
  flush();

  // Accumulate paragraphs into chunks under maxChars, keeping the doc title as
  // context so a chunk retrieved in isolation still knows what it is about.
  const chunks = [];
  let current = [];
  let len = 0;
  for (const p of paras) {
    if (len + p.length > maxChars && current.length) {
      chunks.push(current.join("\n\n"));
      current = [];
      len = 0;
    }
    current.push(p);
    len += p.length;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return { docTitle, chunks: chunks.filter((c) => c.replace(/[#\s]/g, "").length > 0) };
}

function loadCorpus() {
  const dir = join(ROOT, "content", "chatbot-knowledge");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const docs = [];
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const { docTitle, chunks } = chunkMarkdown(text);
    chunks.forEach((content, i) => {
      docs.push({
        id: `${file.replace(/\W+/g, "-")}-${i}`,
        title: docTitle || file,
        source: file,
        content,
      });
    });
  }
  return docs;
}

// --- Azure OpenAI embeddings ----------------------------------------------
async function embed(texts) {
  const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${AZURE_OPENAI_EMBED_DEPLOYMENT}/embeddings?api-version=${AZURE_OPENAI_API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": AZURE_OPENAI_API_KEY },
    body: JSON.stringify({ input: texts }),
  });
  if (!res.ok) throw new Error(`Embeddings failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

// --- Azure AI Search index -------------------------------------------------
async function createIndex() {
  const url = `${AZURE_SEARCH_ENDPOINT.replace(/\/$/, "")}/indexes/${AZURE_SEARCH_INDEX}?api-version=${SEARCH_API}`;
  const body = {
    name: AZURE_SEARCH_INDEX,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "title", type: "Edm.String", searchable: true },
      { name: "source", type: "Edm.String", filterable: true },
      { name: "content", type: "Edm.String", searchable: true },
      {
        name: "contentVector",
        type: "Collection(Edm.Single)",
        searchable: true,
        dimensions: EMBED_DIMS,
        vectorSearchProfile: "vprofile",
      },
    ],
    vectorSearch: {
      algorithms: [{ name: "hnsw-alg", kind: "hnsw" }],
      profiles: [{ name: "vprofile", algorithm: "hnsw-alg" }],
    },
    semantic: {
      configurations: [
        {
          name: "semantic-config",
          prioritizedFields: {
            titleField: { fieldName: "title" },
            prioritizedContentFields: [{ fieldName: "content" }],
          },
        },
      ],
    },
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "api-key": AZURE_SEARCH_ADMIN_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Create index failed ${res.status}: ${await res.text()}`);
  console.log(`Index "${AZURE_SEARCH_INDEX}" created/updated.`);
}

async function uploadDocs(docs) {
  const url = `${AZURE_SEARCH_ENDPOINT.replace(/\/$/, "")}/indexes/${AZURE_SEARCH_INDEX}/docs/index?api-version=${SEARCH_API}`;
  const value = docs.map((d) => ({ "@search.action": "mergeOrUpload", ...d }));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": AZURE_SEARCH_ADMIN_KEY },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`Upload failed ${res.status}: ${await res.text()}`);
  console.log(`Uploaded ${docs.length} chunks.`);
}

// --- main ------------------------------------------------------------------
async function main() {
  const docs = loadCorpus();
  console.log(`Loaded ${docs.length} chunks from the corpus. Embedding...`);

  // Embed in small batches to stay well under request limits.
  const batchSize = 16;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const vectors = await embed(batch.map((d) => `${d.title}\n\n${d.content}`));
    batch.forEach((d, j) => (d.contentVector = vectors[j]));
    console.log(`  embedded ${Math.min(i + batchSize, docs.length)}/${docs.length}`);
  }

  await createIndex();
  await uploadDocs(docs);
  console.log("Done. Chatbot index is ready.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
