# Finanzen – PWA (CSV- & PDF-Import)

Private Einnahmen-/Ausgaben-App für Sparkasse Giro, Miles & More, C24 und Trade Republic.
Alle Daten liegen ausschließlich lokal auf dem Handy (IndexedDB). Kein Server, kein Konto.

## Dateien
- `index.html` – Oberfläche und Design
- `app.js` – Logik, Speicher, Erkennung von Fixkosten und ungewöhnlichen Ausgaben
- `sw.js` – Offline-Funktion
- `manifest.webmanifest`, `icon-*.png` – Installation auf dem Home-Bildschirm

## Veröffentlichen (GitHub Pages, kostenlos)
1. Auf github.com ein neues Repository anlegen, z. B. `finanzen`. Der Code enthält keine Finanzdaten.
2. Alle Dateien aus diesem Ordner hochladen („Add file → Upload files“).
3. Settings → Pages → Branch `main`, Ordner `/ (root)` → Save.
4. Nach ca. 1 Minute ist die App unter `https://<dein-name>.github.io/finanzen/` erreichbar.

## Auf dem Handy installieren
- **iPhone (Safari):** Link öffnen → Teilen → „Zum Home-Bildschirm“.
- **Android (Chrome):** Link öffnen → Menü ⋮ → „App installieren“.

Danach läuft die App auch offline.

## Updates einspielen
Geänderte Dateien hochladen und in `sw.js` die `VERSION` erhöhen (z. B. `finanzen-v2`).
Beim nächsten Öffnen lädt die App die neue Version (eventuell zweimal öffnen).

## Wichtig: Backups
Die Daten liegen nur auf diesem Gerät. Unter **Mehr → Backup erstellen** regelmäßig eine
JSON-Datei sichern (z. B. in iCloud Drive oder Google Drive). Die App erinnert nach 30 Tagen.
