# SEO Content OS Scaffold (Multi-Website)

## Konzept
- **shared/**: globale Baseline-Packs (Blueprints, RulePacks, PromptPacks, Contracts).
- **tenants/**: pro Website Daten + Overrides (DE, EN oder DE+EN).
- **runs/**: jede Ausführung schreibt ein Snapshot (Inputs + resolved_config + Outputs + QA).

## Wie Änderungen automatisch überall wirken
Der Orchestrator lädt pro Run:
1) **shared baseline packs**
2) **tenant overrides** (falls vorhanden)
3) **run_profile** aktiviert Packs + Modus
→ erzeugt **resolved_config/** (und speichert es im Run-Snapshot).

Änderst du Regeln in einem aktivierten Pack, wirken sie im **nächsten Run** automatisch.
Für Stabilität pinnt ihr Versionen (v1/v2/...) und referenced sie im run_profile.

## Schutz vor "leeren" oder vergessenen Infos
- PageSpec muss Pflichtfelder erfüllen (siehe shared/contracts/v1/pagespec.schema.json).
- Wenn Pflichtdaten fehlen: Status = **NEEDS_INPUT** (kein FINAL).
- STRICT: Nur PASS/WARN dürfen exportiert werden; FAIL = BLOCK.

## DE/EN/DE+EN
- Voice & site-spezifische Regeln liegen im Tenant.
- shared Packs liefern Defaults; Overrides ersetzen/erweitern.
- run_profiles definieren, welche Sprachen/Regionen ein Run nutzt.


## International SEO Pack
- Placeholder: `shared/rulepacks/v1/options/international_seo/`
- Aktivierung über `run_profiles/*.json` (wenn mehrsprachig/mehrere Regionen).

## Intake Wizard
- Fragenbank: `shared/intake/v1/intake_questions.csv`
- Antworten landen in den Tenant-CSV-Dateien unter `tenants/<domain>/data/...`
- `allowed_values` ist pipe-delimited (z.B. `a|b|c`) und wird als Liste interpretiert.
 - Transform Hints (Auszug):
   - `upsert_kv`: Ziel ist key/value CSV; `target_field` = key
   - `split_comma`: Werte werden per Komma normalisiert
   - `split_lines`: Werte werden per Zeile normalisiert
   - `to_offer_rows`: erzeugt Offer-Row(s) in `04_offer_catalog.csv`
   - `map_to_usps`: schreibt USP-Liste in `short_promise`/`detailed_description`
   - `to_rule_rows`: schreibt Brand-Voice-Regeln als einzelne Rows
   - `parse_address`: mappt Adresse auf `street/postal_code/city/country`
   - `to_location_entities`: erzeugt Standort-Entities
   - `split_comma_to_rows`: erzeugt CSV-Row pro Item (z.B. Semrush Keywords)

## Local CLI (TS)
In dieser Umgebung bitte `node --import tsx` nutzen (statt `tsx` CLI).

Beispiele:
- `npm run tenant:create -- --domain example.com --site_state existing`
- `npm run page:create -- --tenant example.com --page_id de_service_page_seo-beratung`
- `npm run run -- --tenant example.com --profile service_de_strict`

## Registry v1 (Canonical)
- Topic Registry: `shared/topics/v1/topic_registry.csv`
- Topic Docs: `shared/topics/<topic_id>/v1/topic.md`
- Assets Registry: `shared/assets/v1/assets_registry.csv`

### How to add a Topic (Kurz-Workflow)
1) Row in `shared/topics/v1/topic_registry.csv` ergänzen (topic_id, title, status, doc path).
2) `npm run scaffold:topics` ausführen (erzeugt Ordner + topic.md Skeleton).
3) `npm run validate:registries` laufen lassen und ggf. Pfade/Frontmatter fixen.

### Validate before commit
Bitte vor Commit ausführen:
- `npm run validate:registries`
Optional: Secret-Scan über Git Hook (`.githooks/pre-commit`) oder gitleaks.

### One-command setup
Für frische Clones:
- `npm run setup`
  - setzt `core.hooksPath` auf `.githooks`
  - führt `npm run validate:registries` aus
  - bricht ab, wenn `secrets/**` getrackt ist

### macOS Cleanup (optional)
- `npm run cleanup:mac` (löscht `.DS_Store` außerhalb `node_modules`)

## Connectors & Preflight
- Registry: `shared/connectors/v1/connectors_registry.csv`
- Preflight läuft vor jedem Run und schreibt:
  - `runs/<run_id>/<tenant>/preflight_report.json`
- STRICT: fehlende/ungültige Connectoren blocken den Run.
- DRAFT: fehlende GSC/Rybbit warnen (sichtbar im Report).
- QA darf `missing_data` nur ausgeben, wenn der Preflight `allow_missing_data=true` meldet.

### OpenAI
- Key in `secrets/openai.env` (env: `OPENAI_API_KEY`).

### Google Search Console (GSC)
- OAuth Client in `secrets/google_oauth_client.json` (Google Console, localhost redirect).
- Connect per Tenant:
  - `node --import tsx tools/connect_gsc.ts --tenant <domain> --site_url <https://...>`
- Token landet in:
  - `secrets/tenants/<tenant>/google_gsc_token.json`
- Projekt-Config wird gesetzt:
  - `gsc_enabled=yes`, `gsc_site_url=<...>`, `gsc_connected=yes`, `gsc_connected_at=<iso>`
- Hinweis: GSC unterstützt ausschließlich OAuth 2.0 (keine API-Key Auth).

### Rybbit (optional)
- Wenn `rybbit_enabled=yes`:
  - `secrets/tenants/<tenant>/rybbit.env` (oder JSON) mit Token.


## Site Content Snapshot & Cannibalization
- Für perfekte neue Seiten empfiehlt sich ein Crawl + Content-Snapshot:
  - `tenants/<domain>/data/02_ingest/site_content_snapshot/v1/07_site_content_snapshot.csv`
- Analyzer Outputs:
  - `keyword_cannibalization_report.csv`, `duplicate_content_report.csv`, `internal_link_graph.csv`
