# Shared semantic-search baseline

Semantic Search keeps query embedding and ranking in the browser. A verified shared baseline supplies works released on or before `2026-07-14`; clients embed only works with a valid `YYYY-MM-DD` release later than that cutoff. Production is pinned to Hugging Face revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, Transformers.js `4.0.0-next.4`, q8, and ONNX SHA-256 `f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193`.

## Data contract

The manifest pins the schema, dataset ID, cutoff, embedding model/revision/dtype/artifact hash, 384 dimensions, normalized dot-product vectors, payload recipe, total count, and every shard's encoded/decoded length and SHA-256. Shards are deterministic gzip containers under content-addressed `/semantic-index/objects/<sha256>.bin.gz` keys. Their decoded `ASMRVEC` v1 layout is a fixed little-endian header, deterministic metadata JSON without vectors, then contiguous row-major Float32LE vectors. Decoded shards are capped at 8 MiB; the client also applies global entry and byte limits before fetching. R2 serves gzip bytes without `Content-Encoding`, so the client can hash compressed bytes before bounded decompression and strict parsing.

The browser stores vectors as binary Float32 data in IndexedDB and scores typed arrays directly. Document payloads come from one browser/Node-compatible preparation module, are whitespace-normalized and capped at 640 characters, then receive the exact E5 `passage:` prefix.

The browser verifies each complete shard before importing it under an inactive dataset ID. A single IndexedDB metadata write activates the dataset only after all records and counts validate. Interrupted or corrupt imports are removed without replacing the previous active baseline. A separate delta store overrides matching baseline IDs.

Until a complete verified dataset is active, the existing full-history local indexer and page cursor remain enabled. Activating the baseline atomically removes historical local delta records; only then does the client switch to page-one scanning and embed valid releases after the cutoff. Never publish a partial local export as the complete baseline.

## Publishing

The complete producer performs two sequential, paced `/api/works?pageSize=500` reconciliation passes, resumes page and embedding-batch checkpoints, and performs a fresh final catalog verification after embedding. Reconciliation compares SHA-256 fingerprints of the complete canonical prepared entry and exact `passage:` model input, not just IDs or counts. Every binary embedding checkpoint carries that fingerprint; title, tag, or payload drift invalidates stale embeddings. It retries only network failures, 429, and 5xx responses. Any final drift invalidates unsafe checkpoints and emits no manifest. Use the pinned local cache directory (the last argument is the model revision directory, not its parent):

```bash
node scripts/produce-vector-baseline.mjs \
  https://api.asmr-200.com producer-state out baseline-2026-07-14-v1 \
  /tmp/asmr-hf-cache/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78 16
```

The producer verifies `onnx/model_quantized.onnx`, `config.json`, `tokenizer.json`, and `tokenizer_config.json` against pinned hashes before loading the exact repository dependency. Starting a new attempt revokes any previous output completion marker while preserving crawl and embedding checkpoints, so a failed refresh cannot leave stale output publishable. It builds in a fresh generation directory and promotes it only after writing `semantic-index/complete.json`, whose SHA-256 and length bind it to the manifest. It never publishes. For recovery or testing, the lower-level builder accepts already-embedded entries only when `contract` exactly matches `BASELINE_BUILD_CONFIG`:

```bash
node scripts/build-vector-baseline.mjs entries.json out baseline-2026-07-14-v1
```

Never upload files manually. First validate the completion marker, manifest, and every object without remote writes:

```bash
npm run semantic:publish -- out asmr-semantic-index --dry-run
```

The bucket argument may be omitted; `--dry-run` is recognized in either position and unknown flags fail closed. Validation enforces the client compatibility contract and count/size limits, decompresses and decodes every shard, and checks every entry and ID before any remote operation. After reviewing the dataset ID and hashes, omit `--dry-run` to use pinned Wrangler 4.110.0. The guarded publisher uploads each content-addressed object, downloads and re-hashes it from remote R2, and uploads plus verifies `semantic-index/manifest.json` last:

```bash
npm run semantic:publish -- out asmr-semantic-index
```

The local completion marker is never published. The Worker revalidates the short-lived manifest and serves shards as immutable objects. It exposes no arbitrary R2 key route.

Do not reuse a dataset ID for different bytes. A new embedding model, model revision, cutoff, dimension, normalization rule, or payload recipe requires a compatibility/version change and rebuilding the client delta.
