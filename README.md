# ALM-X2 Thermostat – Karten für Home Assistant

Zwei Karten für das Raumthermostat **ALM-X2** (ALM Controls):

- **ALM-X2 Thermostat** (`custom:alm-x2-card`): ein Thermostat mit allen Funktionen
- **ALM-X2 Übersicht** (`custom:alm-x2-overview-card`): alle ALM-X2 kompakt untereinander (Raum, Ist-Temperatur, Zustand, Sollwert − / +); ein Klick auf den Raum klappt die vollständige Karte auf

![ALM-X2 Thermostat-Karte](https://raw.githubusercontent.com/ALM-Controls/alm-x2-card/main/images/alm-x2-card.png)

Die Thermostat-Karte zeigt:

- Raumtemperatur, Sollwert (− / +), Zustand (heizt, kühlt, ruht, Sensorfehler, Ventilschutz)
- **Betriebsart** Heizen / Kühlen (Parameter 00, Umschalten mit Rückfrage), **Sollwert** nach Wochenprogramm oder manuell (gilt für Heizen und Kühlen), **Ein / Aus**
- zuklappbar: **Wochenprogramm** bearbeiten: Tage, Komforttemperatur, Stunden (Komfort ↔ ECO), auf Mo–Fr / Sa–So / alle Tage übertragen
- **Einstellungen**: ECO-Temperatur, Schaltdifferenz, Sensorkalibrierung, Regelungsmodus (Zweipunkt / PI mit Periode, Kp, Ki), Ventilschutz (Tage, Uhrzeit, Dauer), Tastensperre
- **Einschaltdauer**: heute und an den 7 Tagen davor, Schaltspiele des Relais
- **Gerät**: Firmware, Firmware-Update installieren, WLAN, Link zur Weboberfläche des Thermostats

## Voraussetzungen

- ALM-X2 mit Firmware **X2-V2.07** oder neuer (empfohlen: X2-V2.08)
- Home Assistant mit MQTT-Integration; das Thermostat ist per MQTT verbunden (Weboberfläche › Netzwerk › MQTT) und erscheint automatisch als Gerät

## Installation

**Über HACS (empfohlen):** HACS › Frontend › „ALM-X2 Thermostat“ suchen › Herunterladen. Die Ressource wird automatisch eingetragen.

**Manuell:**
1. `alm-x2-card.js` nach `/config/www/` kopieren (z. B. mit dem Add-on „File editor“ oder per Samba).
2. Einstellungen › Dashboards › ⋮ › Ressourcen › Ressource hinzufügen: URL `/local/alm-x2-card.js`, Typ „JavaScript-Modul“.
3. Browser neu laden.

## Verwendung

Dashboard bearbeiten › Karte hinzufügen › „ALM-X2 Thermostat“ › Thermostat auswählen. Oder als YAML:

```yaml
type: custom:alm-x2-card
entity: climate.x2_buero_thermostat
name: Büro          # optional
```

Übersicht über alle Räume:

```yaml
type: custom:alm-x2-overview-card
title: Thermostate      # optional
entities:               # optional, ohne Angabe: alle ALM-X2
  - climate.x2_buero_thermostat
```

## Hinweise

- Änderungen werden als MQTT-Befehle an das Thermostat gesendet (Dienst `mqtt.publish`) und erscheinen sofort, sobald das Gerät seinen neuen Stand meldet.
- Geräte mit Passwortschutz der Weboberfläche lassen sich trotzdem über die Karte bedienen (MQTT).
- Die Umschaltung Heizen ↔ Kühlen fragt vorher nach.
- Geräte mit älterer Firmware erscheinen in der Übersicht; für alle Funktionen der Thermostat-Karte ist X2-V2.07 nötig.
- Die Karte (ab 0.4) liest die Status-Felder von X2-V2.07 und X2-V2.08; beide Firmware-Stände lassen sich gemischt verwenden.
