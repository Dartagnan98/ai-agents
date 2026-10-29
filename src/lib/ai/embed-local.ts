import 'server-only';
import path from 'path';
import { connSecret, markConnection } from './connections';

// Embeddings for team memory: local unless the agency's own OpenRouter / Voyage keys are saved (below, D 2026-10-28). Local (D, 2026-10-22: memory, ported): bge-small-en-v1.5 through @huggingface/transformers (ONNX,
// 384 dimensions, unit length), no key and no per-search cost. The model downloads once into EMBED_CACHE_DIR. One call at a time per
// process, searches before background work. If it cannot load, embed() returns null and search falls back to words (retried after 10 min).
// Copied from lib/agents/embeddings.ts loader.
export const EMBED_DIMS = 384;
const MODEL = process.env.EMBED_MODEL || 'Xenova/bge-small-en-v1.5';
const BGE_QUERY = 'Represent this sentence for searching relevant passages: ';
const cacheDir = () => process.env.EMBED_CACHE_DIR || path.join(process.env.DATA_DIR || '/var/cache', 'ctrl-os-models');

export type Embedder = (texts: string[], mode: 'query' | 'doc') => Promise<number[][]>;
let testEmbedder: Embedder | null = null;
let model: Embedder | null = null;
let loading: Promise<Embedder | null> | null = null;
let failedAt = 0;

/** Tests swap in a deterministic embedder (null = back to the real model). */
export function setEmbedderForTest(fn: Embedder | null) { testEmbedder = fn; }

function load(): Promise<Embedder | null> {
  if (testEmbedder) return Promise.resolve(testEmbedder);
  if (model) return Promise.resolve(model);
  if (failedAt && Date.now() - failedAt < 600_000) return Promise.resolve(null);
  loading ??= (async () => {
    try {
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = cacheDir();
      const extract = await tf.pipeline('feature-extraction', MODEL, { dtype: 'q8', session_options: { intraOpNumThreads: Math.max(1, Number(process.env.EMBED_THREADS || 2)), interOpNumThreads: 1 } });
      const bge = /bge/i.test(MODEL);
      model = async (texts, mode) => {
        const out = await extract(mode === 'query' && bge ? texts.map((t) => BGE_QUERY + t) : texts, { pooling: bge ? 'cls' : 'mean', normalize: true });
        return out.tolist() as number[][];
      };
      return model;
    } catch (e) {
      failedAt = Date.now();
      console.warn('[embed] model unavailable, team memory searches words only:', e instanceof Error ? e.message : e);
      return null;
    } finally { loading = null; }
  })();
  return loading;
}

// one model call at a time; a search jumps the queue
const queue: { hi: boolean; go: () => void }[] = [];
let busy = false;
async function slot<T>(hi: boolean, fn: () => Promise<T>): Promise<T> {
  if (busy) await new Promise<void>((go) => { if (hi) queue.unshift({ hi, go }); else queue.push({ hi, go }); });
  busy = true;
  try { return await fn(); } finally { busy = false; queue.shift()?.go(); }
}

// ─── paid embeddings (D, 2026-10-28: "voyage and open ai set up for the graph", the agency's own keys) ───
// With an OpenRouter key in Settings › AI connections › Memory, memory and the graph use OpenAI text-embedding-3-large at 1024 dimensions
// (model; ~$0.13 per million tokens). A vector records which model made it (embedTag, kept in ai_mem_chunks.vec_hash), so
// adding or removing the key re-embeds memory in the background and a search only compares vectors of one model.
const PAID = { id: 'openai/text-embedding-3-large', dims: 1024, tag: ':or3l1024' };
const openRouterKey = () => { try { return connSecret('openrouter-key'); } catch { return null; } };
/** Which model makes vectors now: '' = the local one (vectors made before this existed carry no tag), else the paid model's tag. */
export const embedTag = (): string => (testEmbedder ? '' : openRouterKey() ? PAID.tag : '');
/** The vector similarity under which a piece is noise, for the current model (bge-small runs high, 3-large low). */
export const simFloor = (): number => (embedTag() ? 0.3 : 0.55);

async function paidEmbed(key: string, texts: string[], mode: 'query' | 'doc'): Promise<number[][] | null> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST', signal: AbortSignal.timeout(mode === 'query' ? 8_000 : 60_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'AI Agents memory' },
    body: JSON.stringify({ model: PAID.id, input: texts.map((t) => t.slice(0, 8000)), dimensions: PAID.dims }),
  }).catch(() => null);
  if (!res?.ok) {
    if (res && (res.status === 401 || res.status === 402 || res.status === 403)) markConnection('openrouter-key', 'error', `Embeddings answered ${res.status}${res.status === 402 ? ': out of credit' : ''}`);
    return null;
  }
  const j = await res.json().catch(() => null) as { data?: { index?: number; embedding: number[] }[] } | null;
  if (!j?.data || j.data.length !== texts.length) return null;
  const out = new Array<number[]>(texts.length);
  j.data.forEach((d, i) => { const n = Math.hypot(...d.embedding) || 1; out[d.index ?? i] = d.embedding.map((x) => x / n); });
  return out.every((v) => v?.length === PAID.dims) ? out : null;
}

/** Unit vectors for texts, or null when the model is not available. `query` waits at most `waitMs` (a turn never stalls on it).
 *  With the OpenRouter key the paid model answers; if it fails, null (never local vectors under the paid tag: they would not compare). */
export async function embed(texts: string[], mode: 'query' | 'doc', waitMs = 0): Promise<number[][] | null> {
  if (!texts.length) return [];
  const key = testEmbedder ? null : openRouterKey();
  const run = async () => {
    if (key) return paidEmbed(key, texts, mode);
    const m = await load(); return m ? slot(mode === 'query', () => m(texts, mode)) : null;
  };
  if (!waitMs) return run().catch(() => null);
  return Promise.race([run().catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), waitMs))]);
}

// ─── rerank (phase 2, D 2026-10-23): a local cross-encoder reads the question and each candidate together and scores the pair ───
// ms-marco MiniLM-L-6 (q8, ~23 MB): far sharper than vector similarity on short "who / when / what did we decide" questions, ~10 ms a
// pair on this box's CPU. Same queue as embed(); null when it cannot load (the caller keeps its own order).
const RERANK_MODEL = process.env.RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';
export type Reranker = (query: string, docs: string[]) => Promise<number[]>;
let testReranker: Reranker | null = null;
let reranker: Reranker | null = null;
let rerankLoading: Promise<Reranker | null> | null = null;
let rerankFailedAt = 0;
export function setRerankerForTest(fn: Reranker | null) { testReranker = fn; }
function loadReranker(): Promise<Reranker | null> {
  if (testReranker) return Promise.resolve(testReranker);
  if (reranker) return Promise.resolve(reranker);
  if (rerankFailedAt && Date.now() - rerankFailedAt < 600_000) return Promise.resolve(null);
  rerankLoading ??= (async () => {
    try {
      const tf = await import('@huggingface/transformers');
      tf.env.cacheDir = cacheDir();
      const tok = await tf.AutoTokenizer.from_pretrained(RERANK_MODEL);
      const mdl = await tf.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' });
      reranker = async (query, docs) => {
        const inputs = tok(new Array(docs.length).fill(query), { text_pair: docs, padding: true, truncation: true, max_length: 256 });
        const { logits } = await mdl(inputs);
        return (logits.tolist() as number[][]).map((r) => r[0]);
      };
      return reranker;
    } catch (e) {
      rerankFailedAt = Date.now();
      console.warn('[embed] reranker unavailable, keeping search order:', e instanceof Error ? e.message : e);
      return null;
    } finally { rerankLoading = null; }
  })();
  return rerankLoading;
}

// Voyage rerank (D, 2026-10-28) with a Voyage key in Settings › AI connections › Memory: its 0 to 1 relevance is put on the local model's
// scale (about -11 to +11) so the callers' thresholds and lifts stay the same; if Voyage fails, the local model answers.
const VOYAGE_MODEL = process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5';
async function voyageScores(key: string, query: string, docs: string[], waitMs: number): Promise<number[] | null> {
  const res = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST', signal: AbortSignal.timeout(Math.max(300, waitMs)),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: VOYAGE_MODEL, query, documents: docs }),
  }).catch(() => null);
  if (!res?.ok) {
    if (res && (res.status === 401 || res.status === 403)) markConnection('voyage-key', 'error', `Rerank answered ${res.status}`);
    return null;
  }
  const d = await res.json().catch(() => null) as { data?: { index: number; relevance_score: number }[] } | null;
  if (!d?.data) return null;
  const out = docs.map(() => -11);
  for (const r of d.data) if (r.index >= 0 && r.index < out.length) out[r.index] = r.relevance_score * 22 - 11;
  return out;
}

/** A relevance score per doc for `query` (higher = better), or null (no model, or not within `waitMs`). */
export async function rerank(query: string, docs: string[], waitMs: number): Promise<number[] | null> {
  if (!docs.length) return [];
  const vkey = testReranker ? null : (() => { try { return connSecret('voyage-key'); } catch { return null; } })();
  if (vkey) {
    const t0 = Date.now(), v = await voyageScores(vkey, query, docs, waitMs);
    if (v) return v;
    waitMs -= Date.now() - t0;
  }
  const run = async () => { const m = await loadReranker(); return m ? slot(true, () => m(query, docs)) : null; };
  return Promise.race([run().catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(50, waitMs)))]);
}

export const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
export const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
export function dot(a: Float32Array, b: number[] | Float32Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
