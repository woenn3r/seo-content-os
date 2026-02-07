# SEO Content OS – System-README

## Kurzüberblick
Das Repository enthält ein **multi‑tenant SEO‑Content‑Betriebssystem** mit klaren Datenstrukturen, Run‑Profiles, Prompt/Rule‑Packs und einem orchestrierten Pipeline‑Ablauf (Ingest → Analyze → Generate → QA → Export). Es ist darauf ausgelegt, mehrere Websites parallel zu betreiben, wiederverwendbare Wissens‑/Regelpakete zu verwalten und Content‑Produktion reproduzierbar zu machen.

Diese README beschreibt:
- **Was das System bereits kann** (aktuelle Features)
- **Was es können soll** (Roadmap/Intention)
- **Aktueller Stand** (realistisch nutzbar + offene Punkte)

## Was das System bereits kann

### 1) Multi‑Tenant Architektur + Packs
- Struktur für **mehrere Websites** (Tenants) mit globalen Baselines und Tenant‑Overrides.
- **Packs/Registries** als wiederverwendbare Wissens‑/Regel‑Schichten:
  - `shared/` für globale Regeln, Prompts, Verträge/Schemas und Themen.
  - `tenants/<domain>/` für projekt‑spezifische Overrides.
- **Run‑Profile** steuern Modus, Packs, Sprachen/Regionen und die Vertragsversionen.

### 2) Orchestrierte Pipeline
Im Kern läuft die Pipeline in festen Schritten (siehe `core/src/orchestrator/run.ts`):
- **Intake** (interaktiver Fragebogen + CSV‑Datenpflege)
- **Preflight** (Connector‑Checks, blockiert bei fehlenden Pflichtzugängen)
- **Ingest** (z. B. Site‑Snapshot, Crawl, strukturierte Inputs)
- **Analyze** (SERP‑Wettbewerber, GSC, PageSpeed, Analytics)
- **Generate** (Content‑Generierung aus Prompts/Rules/Blueprints)
- **QA** (Validierung gegen Regeln/Contracts)
- **Export** (Seitenexport + Run‑Snapshot)

Zusätzlich:
- **Iterative Generation** für „perfect“‑Modus: QA‑Fixlisten → erneute Generierung bis PASS oder max. Iterationen.
- **Run‑Snapshots**: vollständige Reproduzierbarkeit eines Laufs inkl. resolved_config, Inputs und Outputs.

### 3) Daten‑ und Registry‑System
- Zentrale Registries für Topics, Assets und Connectoren.
- Konsistente CSV‑basierte Datenspeicherung für Angebote, Entities, Produkte, Pagespec, Schema‑Plan etc.
- **Schemas/Contracts** sichern Pflichtfelder und Export‑Stabilität.

### 4) Intake‑Wizard & strukturierte Eingabe
- Interaktiver Start‑Workflow (`npm run start`) mit:
  - Tenant‑Erstellung
  - Projekt‑Config
  - Offers/Entities/Produkte/Collections
  - Page‑Status & System‑Checks
- CSV/Markdown‑Eingabefiles zur standardisierten Datenerfassung.

### 5) Konnektoren + Preflight
- **OpenAI**, **Google Search Console**, **PageSpeed**, **Rybbit** sind über Preflight prüfbar.
- Preflight blockiert **strict_production**, wenn essentielle Credentials fehlen.
- Warn‑Modus für nicht‑kritische Integrationen.

### 6) SEO‑Strategie & Content‑Struktur
- **Pagespec** als zentrale Steuerdatei für Seitentypen, Status und Inhalte.
- **Schema‑Plan** je Seite (Schema‑Abdeckung).
- **Interne Verlinkungsplanung** als Schritt vor der Generierung.
- Keyword‑ und Topic‑Ingest (Tools vorhanden).

### 7) System‑Audit & Health‑Checks
- `npm run audit:system` + `npm run audit:system:deep`.
- Topic‑Coverage‑Checks (Prompt/Rules‑Lücken).
- System‑Check der READY‑Pages inkl. Schema‑Plan‑Vollständigkeit.

### 8) P4‑Learning (Content Quality)
- Lern‑Logs + Aggregation vorhanden (`learn:p4`, `learn:p4:apply`).
- „Learned Overlay“ in Writer‑Prompts implementiert.

## Was das System können soll (Zielbild / Roadmap)

### P4 – Writer‑Prompts & Task‑Agents
Ziel: **perfekte Texterstellung pro Seitentyp** + granulare Task‑Prompts.

Geplant (siehe `todo.md`):
- **Best‑Practice‑Beispiele** pro Seitentyp sammeln und analysieren.
- Automatisches Ableiten von:
  - Section‑Blueprints
  - Meta‑Regeln
  - Slot‑Mappings
- **Task‑Module** aus Best‑Practice‑Seiten:
  - Outline, Brief, Tone, Quellen, Media
- **Schema/Technical Task‑Prompts** aus Schema‑OS/Best‑Practice ableiten

### Ausbau „Perfect Mode“
- Noch stärkere Iteration & automatische Fix‑Vorschläge.
- Bessere QA‑Abdeckung auf Block/Section‑Ebene.

### Bessere Autostrategy
- Mehr Automatik beim Clustering von Keywords und Ableitung der Seitenstruktur.

## Aktueller Stand (realistisch nutzbar)

### Stabil & produktiv nutzbar
- Multi‑Tenant Setup
- Run‑Profiles + Pack‑Resolution
- Pipeline‑Orchestrierung inklusive Export & Snapshot
- Intake‑Wizard + strukturierte CSV‑Datenerfassung
- Preflight Connector‑Checks
- Analyse‑Basis (GSC/PageSpeed/SERP/Analytics)
- Interne Verlinkungsplanung
- QA‑Validierung + Iteration (falls „perfect“ aktiviert)

### Teilweise umgesetzt / im Aufbau
- P4‑Learning: Aggregation vorhanden, Best‑Practice‑Ableitung noch ausbaufähig.
- Task‑Prompts: Konzept vorhanden, Implementierung noch ausstehend.
- Schema/Tech‑Task‑Prompts: definiert in Roadmap, noch nicht umgesetzt.

### Offene Punkte (aus `todo.md`)
- Best‑Practice‑Sammlung pro Seitentyp (Inputbasis fehlt).
- Ableitung der Task‑Module aus realen Seiten.
- Erweiterung der Schema‑/Tech‑Tasks.

## Ordnerstruktur (wichtigste Teile)
- `seo_content_os_scaffold_v4/`
- `seo_content_os_scaffold_v4/shared/` – globale Packs, Contracts, Topics, Assets, Connectors
- `seo_content_os_scaffold_v4/tenants/` – projekt‑spezifische Daten & Overrides
- `seo_content_os_scaffold_v4/runs/` – Ausführungen + Snapshots
- `core/src/` – Pipeline, Orchestrator, Validierung, Utils
- `tools/` – CLI‑Tools für Intake, Run, Audit, Scaffolding, Sync

## Quick Start (lokal)
1. `npm install`
2. `npm run start`
3. Tenant auswählen/erstellen, Daten eingeben, Run‑Profil wählen
4. `npm run run -- --tenant <domain> --profile <profile_id>`

## Wichtige Hinweise
- Für **strict_production** sind valide Connector‑Credentials Pflicht.
- `resolved_config.json` im Run‑Snapshot ist die zentrale Quelle für die effektiven Regeln/Prompts/Contracts eines Runs.
- Änderungen in aktivierten Packs wirken ab dem nächsten Run.

---

Wenn du willst, kann ich als nächsten Schritt die README gezielt auf ein bestimmtes Ziel anpassen (z. B. Onboarding, Entwickler‑Doku, interne Produkt‑Doku) oder direkt mit konkreten Beispielen/Use‑Cases ergänzen.
