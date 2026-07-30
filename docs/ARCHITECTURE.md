# Architecture

Two programs that never call each other. The Expo app is offline-first and owns your
pieces; the Python ETL is a scheduled scraper that owns the glaze catalog. Their only
shared surface is Postgres — specifically the RPC signatures in `supabase/migrations/`.

```mermaid
graph TD
  subgraph app["Expo app — src/ (TypeScript, SDK 54 + Expo Go)"]
    screens["app/ — Expo Router screens<br/>shelf · piece timeline · glaze search · your lists · glaze detail"]
    components["components/ — presentation only"]
    glazes["lib/glazes/ — catalog client<br/>types · catalog · grouping · hooks"]
    localdb["db/ — expo-sqlite + Drizzle<br/>pieces · entries · media · glaze marks"]
    screens --> components
    screens --> glazes
    screens --> localdb
  end

  subgraph pg["Postgres / Supabase — supabase/"]
    rpc["RPCs: search_glazes · glaze_by_code · glaze_appearances · similar_glazes<br/>every lookup takes (manufacturer, code)"]
    tables["glazes · glaze_images · appearances<br/>vocabularies · parse_issues"]
    bucket["private Storage bucket<br/>image derivatives, signed URLs"]
    rpc --> tables
  end

  subgraph etl["Glaze ETL — etl/glaze_etl/ (Python 3.12, uv)"]
    entry["cli.py · worker.py · workflows/ (Temporal)"]
    activities["activities/crawl.py — retries, scheduling"]
    pipeline["core/pipeline.py — stage order"]
    adapter["core/source_adapter.py (ABC)"]
    amaco["sources/amaco/ — discovery · parser · filename grammar"]
    pure["core/ pure stages<br/>composite_splitter · color · color_namer · normalizer"]
    io["core/ I/O<br/>fetcher · media · blob_store · store · loader"]
    entry --> activities --> pipeline
    pipeline --> adapter
    adapter -. implemented by .-> amaco
    pipeline --> pure
    pipeline --> io
  end

  glazes -->|"anon key, read only"| rpc
  io -->|"service role, writes"| tables
  io --> bucket
  glazes -.->|"signed URLs"| bucket
  amaco -->|"polite crawl"| amacoweb["shop.amaco.com"]
```

**Expo app (`src/`)** owns everything about *your* pottery, stored locally in SQLite so it
works with no signal and no account. It reads the glaze catalog over the anon key and never
writes to it. Wishlist/owned/favourite marks are deliberately local: the catalog has no idea
what you own, and should not.

A glaze is named by **`(manufacturer, code)`**, never by code alone — in the RPCs, in the
detail route, and in the local marks table. `glazes` has always been unique on that pair, and
two brands are free to spell a code the same way, so anything resolving a bare code was picking
a brand arbitrarily.

**Postgres (`supabase/`)** is the contract. Migrations are append-only history — the schema
changes by adding a migration, never by editing one. The three RPCs are the only shape the
app depends on, which is why they are hand-mirrored in `src/lib/glazes/types.ts` rather than
generated.

**Glaze ETL (`etl/`)** is a standalone uv project, excluded from the Metro bundle. Everything
manufacturer-specific lives behind `SourceAdapter`; a second manufacturer is one new subclass
plus its grammar, with no change to a stage, workflow, or table. The parse stage is pure — no
network, no clock, no database — which is what lets a reparse replay the whole corpus in
seconds.
