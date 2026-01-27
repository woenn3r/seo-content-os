# TODO – OpenAI Key & Secrets Troubleshooting

## 1) Repo-Root sicherstellen
- Öffne ein Terminal und wechsle ins Repo:
  - `cd /Users/janikahler/Desktop/AntiGravity/content-erstellen`
- Prüfe, dass der Ordner existiert:
  - `ls -la`

## 2) Secrets-Ordner sichtbar machen
- Prüfe, ob der Ordner existiert:
  - `ls -la secrets`
- Erwartet:
  - `secrets/.gitignore`
  - `secrets/README.md`
  - `secrets/openai.env`

## 3) Inhalt von openai.env prüfen (ohne den Key zu posten)
- Zeige nur die Länge + Prefix:
  - `node --import tsx -e 'import { loadEnv } from "./core/src/utils/loadEnv.ts"; loadEnv(); const key=process.env.OPENAI_API_KEY||""; console.log("key_loaded", Boolean(key)); console.log("key_length", key.length); console.log("key_prefix", key.slice(0,3));'`
- Erwartet:
  - `key_loaded true`
  - `key_length` > 40
  - `key_prefix sk-`

## 4) Key korrekt in die Shell laden (aus openai.env)
- Lade den Key explizit aus der Datei:
  - `export OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' secrets/openai.env | cut -d= -f2- | tr -d '"')"`
- Prüfe, ob er gesetzt ist:
  - `echo "$OPENAI_API_KEY" | wc -c`

## 5) API-Check (curl)
- Teste Zugriff:
  - `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $OPENAI_API_KEY" "https://api.openai.com/v1/models"`
- Erwartet:
  - `200` = Key gültig
  - `401` = Key ungültig/disabled/falscher Key

## 6) Wenn 401
- Im OpenAI Dashboard:
  - Neuen Key erstellen
  - Alten deaktivieren
- Neuen Key in `secrets/openai.env` eintragen:
  - `OPENAI_API_KEY="sk-..."`
- Schritte 4–5 wiederholen

## 7) Warum Gitignore kein Problem ist
- `.gitignore` verhindert nur das Committen.
- Das Programm kann die Datei trotzdem lesen.
- Wenn `loadEnv()` `key_loaded true` zeigt, wird die Datei korrekt gefunden.

## 8) Wenn der Ordner „nicht da“ wirkt
- Du bist wahrscheinlich im falschen Ordner.
- Prüfe den vollständigen Pfad:
  - `ls -la /Users/janikahler/Desktop/AntiGravity/content-erstellen/secrets`

## 9) Danach
- Wenn curl 200 liefert: bitte kurz bestätigen.
- Dann mache ich den integrierten Test und wir gehen mit Schritt 3 weiter.
