/*
 * ALM-X2 Thermostat cards for Home Assistant (ALM Controls)
 *
 *   type: custom:alm-x2-card            one thermostat with all functions
 *   entity: climate.x2_office_thermostat
 *   name: Büro                          # optional
 *
 *   type: custom:alm-x2-overview-card   all ALM-X2 in one compact list (found automatically)
 *   title: Thermostate                  # optional
 *   entities: [climate.a, climate.b]    # optional, otherwise all ALM-X2
 *
 * Operating mode (heat / cool, parameter 00) and setpoint control (week program / manual) are independent:
 * the week program applies to heating and cooling alike. In HA: HVAC mode heat / cool / off, preset
 * "Wochenprogramm" / "Manuell" (firmware X2-V2.07).
 *
 * Needs firmware X2-V2.07 or newer (MQTT discovery with attributes). X2-V2.08 reports "temporary" and "relay"
 * (true/false) instead of schedulesMode "boost" and relay1 "on"/"off"; both are read. Values come from the entities of the
 * device (attributes of the climate entity, "Firmware", "Komforttemperatur heute", "Einschaltdauer heute");
 * changes go to the device as MQTT commands (mqtt.publish to <device>/cmnd/thermostat/...), setpoint and mode
 * through the climate entity.
 */
const CARD_VERSION = "0.4";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAYS_DE = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WD_JS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

// parameters: key, label, min, max, step, unit
const PARAMS = [
  ["EcoTemperature", "ECO-Temperatur", 10, 19.9, 0.1, "°C"],
  ["Tdifference", "Schaltdifferenz", 0.4, 2, 0.1, "K"],
  ["Tadjust", "Kalibrierung", -5, 5, 0.1, "K"],
];
const PI_PARAMS = [
  ["PI_Period", "PI Periode", 1, 60, 1, "min"],
  ["PI_Prop_Kp", "PI Kp", 1, 60, 1, ""],
  ["PI_Integral_Ki", "PI Ki", 0, 60, 1, ""],
];
const VALVE_PARAMS = [
  ["valveDays", "nach Tagen", 1, 30, 1, "d"],
  ["valveHour", "um", 0, 23, 1, "Uhr"],
  ["valveMinutes", "für", 1, 30, 1, "min"],
];

const fmt = (v, d = 1) => (v === null || v === undefined || isNaN(v) ? "–" : Number(v).toFixed(d).replace(".", ","));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const minShort = (m) => (m >= 60 ? Math.floor(m / 60) + " h " + (m % 60) + " min" : (m || 0) + " min");
const parseNum = (s) => {
  const t = String(s ?? "").trim().replace(",", ".");
  return t === "" ? NaN : Number(t);
};
// "6–8, 16–23 Uhr" from 24 comfort flags
function hourRanges(h) {
  const r = [];
  for (let i = 0; i < 24; i++) {
    if (!h[i]) continue;
    let j = i;
    while (j + 1 < 24 && h[j + 1]) j++;
    r.push(`${i}–${j + 1}`);
    i = j;
  }
  return r.length ? r.join(", ") + " Uhr" : "nur ECO";
}

function isX2(hass, entityId) {
  const reg = hass.entities && hass.entities[entityId];
  const dev = reg && hass.devices && hass.devices[reg.device_id];
  return !!dev && dev.model === "ALM-X2";
}

// entities of the device of a climate entity, found by their attributes (independent of renamed entities)
function resolveX2(hass, climate) {
  const reg = hass.entities && hass.entities[climate];
  const did = reg && reg.device_id;
  const ids = did ? Object.values(hass.entities).filter((e) => e.device_id === did).map((e) => e.entity_id) : [];
  const st = (e) => hass.states[e];
  const find = (pred) => ids.find((e) => st(e) && pred(e, st(e).attributes || {}));
  return {
    device: did && hass.devices ? hass.devices[did] : null,
    climate: st(climate),
    schedule: st(find((e, a) => a.topic !== undefined && a.Monday !== undefined)),
    config: st(find((e, a) => a.RegulationMode !== undefined)),
    stats: st(find((e, a) => Array.isArray(a.days) && a.relayCycles !== undefined)),
    update: find((e) => e.startsWith("update.")),
    rssi: st(find((e, a) => e.startsWith("sensor.") && a.device_class === "signal_strength")),
  };
}

// setpoint changed until 0:00 / relay on: X2-V2.08 (temporary, relay) or X2-V2.07 (schedulesMode, relay1)
const isTemporary = (a) => (a.temporary !== undefined ? !!a.temporary : a.schedulesMode === "boost");
const isManual = (a) => (a.preset_mode || a.preset || (a.schedulesMode === "home" ? "Manuell" : "Wochenprogramm")) === "Manuell";
const relayOn = (a) => (a.relay !== undefined ? !!a.relay : a.relay1 === "on");

function x2State(c) {
  const a = c.attributes;
  if (c.state === "unavailable") return ["nicht erreichbar", "err"];
  if (a.sensorError) return ["Sensorfehler", "err"];
  if (a.valveExercise) return ["Ventilschutz", "valve"];
  if (a.hvac_action === "heating") return ["heizt", "heat"];
  if (a.hvac_action === "cooling") return ["kühlt", "cool"];
  if (c.state === "off") return ["aus", "off"];
  return ["ruht", ""];
}

const STYLE = `
 :host{--x2-heat:var(--state-climate-heat-color,#ff8100);--x2-cool:var(--state-climate-cool-color,#2b9af9);--x2-auto:var(--state-climate-auto-color,#4caf50);
  --x2-soft:rgba(127,127,127,.10);--x2-r:12px}
 ha-card{padding:16px;overflow:hidden}
 .row{display:flex;align-items:center;gap:8px}.between{justify-content:space-between}.grow{flex:1;min-width:0}
 .title{font-size:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .sub{color:var(--secondary-text-color);font-size:13px}
 .cur{font-size:30px;font-weight:300;line-height:1;white-space:nowrap}
 .chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:600;background:var(--x2-soft);color:var(--primary-text-color);white-space:nowrap}
 .chip.heat{background:color-mix(in srgb,var(--x2-heat) 18%,transparent);color:var(--x2-heat)}
 .chip.cool{background:color-mix(in srgb,var(--x2-cool) 18%,transparent);color:var(--x2-cool)}
 .chip.valve{background:color-mix(in srgb,var(--x2-auto) 18%,transparent);color:var(--x2-auto)}
 .chip.err{background:rgba(219,68,55,.15);color:var(--error-color,#db4437)}
 .setp{display:flex;align-items:center;justify-content:center;gap:18px;margin:14px 0 2px}
 .round{width:40px;height:40px;border-radius:50%;border:0;background:var(--x2-soft);color:var(--primary-text-color);font-size:22px;cursor:pointer;display:flex;align-items:center;justify-content:center}
 .round:active{transform:scale(.94)}
 .val{font-size:34px;font-weight:500;min-width:120px;text-align:center;line-height:1}
 .info{text-align:center;color:var(--secondary-text-color);font-size:12px;min-height:16px;margin-top:4px}
 .ctrl{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin:12px 0 6px}
 .seg2{display:grid;grid-template-columns:1fr 1fr;background:var(--x2-soft);border-radius:var(--x2-r);padding:3px;gap:3px}
 .seg2 button,.pwr{display:flex;align-items:center;justify-content:center;gap:4px;padding:7px 2px;border:0;border-radius:9px;background:none;color:var(--primary-text-color);cursor:pointer;font-size:12px;white-space:nowrap}
 .seg2 button ha-icon,.pwr ha-icon{--mdc-icon-size:18px}
 .seg2 button.on{background:var(--card-background-color);box-shadow:0 1px 3px rgba(0,0,0,.18);font-weight:600}
 .seg2 button.on[data-hc=heat]{color:var(--x2-heat)}.seg2 button.on[data-hc=cool]{color:var(--x2-cool)}
 .seg2 button.on[data-pr]{color:var(--primary-color)}
 .off .seg2 button.on{box-shadow:none;background:none;font-weight:400;color:var(--secondary-text-color)}
 .pwr{width:44px;background:var(--x2-soft);border-radius:var(--x2-r)}
 .pwr.on{background:var(--primary-color);color:var(--text-primary-color,#fff)}
 details{border-top:1px solid var(--divider-color)}
 summary{list-style:none;display:flex;align-items:center;gap:10px;padding:11px 2px;cursor:pointer;font-size:14px}
 summary::-webkit-details-marker{display:none}
 summary ha-icon{--mdc-icon-size:20px;color:var(--secondary-text-color)}
 summary .sum{margin-left:auto;color:var(--secondary-text-color);font-size:12px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
 summary .chev{transition:transform .2s;margin-left:4px}details[open] summary .chev{transform:rotate(90deg)}
 .body{padding:0 2px 12px}
 .days{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:8px}
 .days button{padding:6px 0;border-radius:8px;border:0;background:var(--x2-soft);color:var(--primary-text-color);cursor:pointer;font-size:13px}
 .days button.on{background:var(--primary-color);color:var(--text-primary-color,#fff)}
 .hours{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin:6px 0 2px}
 .hours button{height:30px;padding:0;border:0;border-radius:4px;background:var(--x2-soft);cursor:pointer}
 .hours button.c{background:var(--x2-heat)}.cooling .hours button.c{background:var(--x2-cool)}
 .hlab{display:grid;grid-template-columns:repeat(24,1fr);font-size:10px;color:var(--secondary-text-color)}.hlab span{text-align:left}
 @media (max-width:520px){.hours{grid-template-columns:repeat(12,1fr);gap:4px}.hours button{height:34px}.hours button::after{content:attr(data-h);font-size:10px;color:var(--secondary-text-color)}.hours button.c::after{color:#fff}.hlab{display:none}}
 .locked{opacity:.45;pointer-events:none}
 .round:disabled{opacity:.35;cursor:default}
 label{display:block;font-size:11px;color:var(--secondary-text-color);margin:8px 0 3px}
 input,select{width:100%;box-sizing:border-box;padding:7px 8px;border-radius:8px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);font-size:14px}
 .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
 .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
 .btn{padding:6px 12px;border-radius:99px;border:0;background:var(--x2-soft);color:var(--primary-text-color);cursor:pointer;font-size:12px;text-decoration:none}
 .btn.pri{background:var(--primary-color);color:var(--text-primary-color,#fff)}
 .sw{display:flex;align-items:center;justify-content:space-between;margin:10px 0 2px;font-size:14px}
 .sw input{width:auto;transform:scale(1.2)}
 .bars{display:flex;align-items:flex-end;gap:6px;height:64px}.bars div{flex:1;background:var(--x2-heat);opacity:.55;border-radius:4px 4px 0 0;min-height:2px}.bars div.t{opacity:1}
 .cooling .bars div{background:var(--x2-cool)}
 .blab{display:flex;gap:6px;margin-top:3px}.blab span{flex:1;text-align:center;font-size:10px;color:var(--secondary-text-color)}
 dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:13px}dt{color:var(--secondary-text-color)}dd{margin:0}
 .muted{color:var(--secondary-text-color);font-size:12px}.hidden{display:none!important}
 .toast{font-size:12px;min-height:14px;text-align:center;color:var(--secondary-text-color)}.toast.err{color:var(--error-color,#db4437)}
`;

class AlmX2Card extends HTMLElement {
  static getStubConfig(hass) {
    return { entity: Object.keys(hass.states).find((e) => e.startsWith("climate.") && isX2(hass, e)) || "" };
  }

  static getConfigElement() {
    return document.createElement("alm-x2-card-editor");
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("Bitte das Thermostat wählen (entity: climate.…)");
    this._config = config;
    this._day = this._day ?? (new Date().getDay() + 6) % 7;
    if (this._built) this._update();
  }

  getCardSize() {
    return 6;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
  }

  _publish(part, obj) {
    const topic = this._e.schedule && this._e.schedule.attributes.topic;
    if (!topic) {
      this._toast("Gerät nicht gefunden (Firmware ab X2-V2.07 nötig)", true);
      return Promise.reject(new Error("no topic"));
    }
    return this._hass.callService("mqtt", "publish", { topic: `${topic}/cmnd/thermostat/${part}`, payload: JSON.stringify(obj) })
      .catch((e) => { this._toast(e.message || String(e), true); throw e; });
  }

  // ---------------------------------------------------------------- layout (built once)

  _build() {
    this._built = true;
    this.attachShadow({ mode: "open" });
    const field = (p) => `<div><label for="p_${p[0]}">${esc(p[1])}${p[5] ? " (" + p[5] + ")" : ""}</label><input id="p_${p[0]}" inputmode="decimal"></div>`;
    const section = (id, icon, title, body) =>
      `<details id="s_${id}"><summary><ha-icon icon="${icon}"></ha-icon><span>${title}</span><span class="sum" id="sum_${id}"></span><ha-icon class="chev" icon="mdi:chevron-right"></ha-icon></summary><div class="body">${body}</div></details>`;
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
<ha-card id="card">
 <div class="row between">
  <div class="grow"><div class="title" id="name"></div><div class="sub" id="sub"></div></div>
  <div style="text-align:right"><div class="cur" id="cur">–</div><span class="chip" id="act"></span></div>
 </div>
 <div class="setp"><button class="round" id="minus" aria-label="Sollwert senken"><ha-icon icon="mdi:minus"></ha-icon></button><div class="val" id="set">–</div><button class="round" id="plus" aria-label="Sollwert erhöhen"><ha-icon icon="mdi:plus"></ha-icon></button></div>
 <div class="info" id="modeInfo"></div>
 <div class="ctrl" id="ctrl">
  <div class="seg2" id="hcSeg" title="Betriebsart"><button data-hc="heat"><ha-icon icon="mdi:fire"></ha-icon>Heizen</button><button data-hc="cool"><ha-icon icon="mdi:snowflake"></ha-icon>Kühlen</button></div>
  <div class="seg2" id="prSeg" title="Sollwert"><button data-pr="Wochenprogramm"><ha-icon icon="mdi:calendar-clock"></ha-icon>Programm</button><button data-pr="Manuell"><ha-icon icon="mdi:hand-back-right"></ha-icon>Manuell</button></div>
  <button class="pwr" id="pwr" title="Ein / Aus" aria-label="Ein / Aus"><ha-icon icon="mdi:power"></ha-icon></button>
 </div>
 <div class="toast" id="toast"></div>
 ${section("week", "mdi:calendar-week", "Wochenprogramm", `
  <div class="days" id="days">${DAYS_DE.map((d, i) => `<button data-d="${i}">${d}</button>`).join("")}</div>
  <div class="hours" id="hours">${Array.from({ length: 24 }, (_, h) => `<button data-h="${h}" title="${h}–${h + 1} Uhr" aria-label="${h}–${h + 1} Uhr Komfort" aria-pressed="false"></button>`).join("")}</div>
  <div class="hlab">${Array.from({ length: 24 }, (_, h) => `<span>${h % 6 === 0 ? h : ""}</span>`).join("")}</div>
  <div class="grid2"><div><label for="wTemp">Komfort (20,0–40,0 °C)</label><input id="wTemp" inputmode="decimal"></div><div><label>ECO</label><div class="muted" id="ecoInfo" style="padding-top:8px"></div></div></div>
  <div class="btns"><button class="btn" data-copy="0,1,2,3,4">→ Mo–Fr</button><button class="btn" data-copy="5,6">→ Sa–So</button><button class="btn" data-copy="0,1,2,3,4,5,6">→ alle Tage</button></div>
  <div class="btns"><button class="btn pri" id="wSave">Speichern</button><button class="btn" id="wReset">Verwerfen</button></div>`)}
 ${section("set", "mdi:tune-variant", "Einstellungen", `
  <div class="grid3">${PARAMS.map(field).join("")}</div>
  <label for="reg">Regelungsmodus</label><select id="reg"><option value="normalClose">Zweipunkt (NC)</option><option value="PI control">PI-Regler</option></select>
  <div class="grid3" id="piParams">${PI_PARAMS.map(field).join("")}</div>
  <div class="sw"><span>Ventilschutz</span><input type="checkbox" id="valve"></div>
  <div class="grid3" id="valveParams">${VALVE_PARAMS.map(field).join("")}</div>
  <div class="sw"><span>Tastensperre am Gerät</span><input type="checkbox" id="lock"></div>
  <div class="btns"><button class="btn pri" id="cSave">Speichern</button><button class="btn" id="cReset">Verwerfen</button></div>`)}
 ${section("stat", "mdi:chart-bar", "Einschaltdauer", `<div class="bars" id="bars"></div><div class="blab" id="blab"></div><p class="muted" id="statInfo"></p>`)}
 ${section("info", "mdi:information-outline", "Gerät", `<dl id="dl"></dl>
  <div class="btns"><button class="btn pri hidden" id="upd">Firmware installieren</button><a class="btn" id="web" target="_blank" rel="noopener">Weboberfläche</a></div>`)}
</ha-card>`;
    const $ = (id) => this.shadowRoot.getElementById(id);
    this.$ = $;

    // one section open at a time
    this.shadowRoot.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => {
      if (d.open) this.shadowRoot.querySelectorAll("details").forEach((o) => { if (o !== d) o.open = false; });
    }));

    // setpoint: several taps are collected and sent once
    const step = (d) => {
      const c = this._e && this._e.climate;
      if (!c || c.state === "off" || c.state === "unavailable") return;
      const base = this._pendingSet ?? c.attributes.temperature;
      this._pendingSet = Math.min(40, Math.max(10, Math.round((base + d) * 10) / 10));
      $("set").textContent = fmt(this._pendingSet) + " °C";
      clearTimeout(this._setT);
      this._setT = setTimeout(() => {
        const v = this._pendingSet;             // the value sent; a newer tap is kept (audit K2)
        if (v == null) return;
        this._hass.callService("climate", "set_temperature", { entity_id: this._config.entity, temperature: v })
          .catch((e) => this._toast(e.message, true))
          .finally(() => setTimeout(() => { if (this._pendingSet === v) { this._pendingSet = null; this._update(); } }, 2500));
      }, 800);
    };
    $("minus").onclick = () => step(-0.5);
    $("plus").onclick = () => step(0.5);

    $("hcSeg").onclick = (ev) => {
      const b = ev.target.closest("button");
      if (b) this._setHeatCool(b.dataset.hc);
    };
    $("prSeg").onclick = (ev) => {
      const b = ev.target.closest("button");
      if (b) this._climate("set_preset_mode", { preset_mode: b.dataset.pr });
    };
    // on/off as the power key: the operating mode (parameter 00) stays as it is (audit K3)
    $("pwr").onclick = () => {
      const c = this._e && this._e.climate;
      if (!c) return;
      this._publish("config", { power: c.state === "off" ? "on" : "off" }).catch(() => {});
    };

    // week program
    $("days").onclick = (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      this._readTemp();
      this._day = +b.dataset.d;
      this._drawWeek();
    };
    $("hours").onclick = (ev) => {
      const b = ev.target.closest("button");
      if (!b || !this._week) return;
      const h = this._week[this._day].h;
      h[+b.dataset.h] = !h[+b.dataset.h];
      this._weekDirty = true;
      this._drawWeek();
    };
    $("wTemp").addEventListener("input", () => (this._weekDirty = true));
    this.shadowRoot.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => {
      if (!this._week) return;
      this._readTemp();
      const src = this._week[this._day];
      b.dataset.copy.split(",").map(Number).forEach((i) => (this._week[i] = { t: src.t, h: src.h.slice() }));
      this._weekDirty = true;
      this._toast("Übernommen – noch speichern");
    }));
    $("wReset").onclick = () => { this._weekDirty = false; this._week = null; this._update(); };
    $("wSave").onclick = () => this._saveWeek();

    // settings
    this.shadowRoot.querySelectorAll("#s_set input,#s_set select").forEach((i) => {
      if (i.id !== "lock") i.addEventListener("input", () => { this._cfgDirty = true; this._updateSettingsVisibility(); });
    });
    $("cReset").onclick = () => { this._cfgDirty = false; this._update(); };
    $("cSave").onclick = () => this._saveConfig();
    $("lock").onchange = () => this._publish("properties", { locked: $("lock").checked }).catch(() => {});
    $("upd").onclick = () => {
      if (!confirm("Neue Firmware auf dem Thermostat installieren? Das Gerät startet danach neu.")) return;
      this._hass.callService("update", "install", { entity_id: this._e.update }).catch((e) => this._toast(e.message, true));
    };
  }

  _toast(msg, err) {
    const t = this.$("toast");
    t.textContent = msg;
    t.className = "toast" + (err ? " err" : "");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => (t.textContent = ""), err ? 6000 : 2500);
  }

  _climate(service, data) {
    return this._hass.callService("climate", service, { entity_id: this._config.entity, ...data })
      .catch((e) => this._toast(e.message || String(e), true));
  }

  _heatCool() {
    const cfg = (this._e && this._e.config && this._e.config.attributes) || {};
    return cfg.heatCool === "cool" ? "cool" : "heat";
  }

  // operating mode (parameter 00): the HVAC mode heat / cool of the climate entity; the week program or the
  // manual setpoint stay as they are. A change asks first (floor heating vs. cooling)
  _setHeatCool(m) {
    const c = this._e && this._e.climate;
    if (!c) return;
    if (m === this._heatCool()) return;
    if (!confirm(`Betriebsart auf ${m === "cool" ? "Kühlen" : "Heizen"} umstellen?`)) return;
    // only the parameter: an OFF device stays off (the HVAC mode heat/cool of HA would switch it on, audit K4)
    this._publish("config", { heatCool: m }).then(() => this._toast(m === "cool" ? "Kühlbetrieb" : "Heizbetrieb")).catch(() => {});
  }

  // ---------------------------------------------------------------- values

  _update() {
    if (!this._hass || !this._config) return;
    const $ = this.$;
    const e = (this._e = resolveX2(this._hass, this._config.entity));
    const c = e.climate;
    if (!c) {
      $("name").textContent = "Thermostat nicht gefunden";
      $("sub").textContent = this._config.entity;
      return;
    }
    const a = c.attributes, cfg = (e.config && e.config.attributes) || {}, dev = e.device || {};
    const cooling = cfg.heatCool === "cool";
    $("card").classList.toggle("cooling", cooling);
    $("name").textContent = this._config.name || dev.name_by_user || dev.name || a.friendly_name;
    const oldFw = !e.schedule || !e.config || (a.hvac_modes || []).includes("auto");
    $("sub").textContent = oldFw ? "Firmware ab X2-V2.07 für alle Funktionen"
      : (cooling ? "Kühlbetrieb" : "Heizbetrieb") + (a.locked ? " · Tastensperre" : "");
    // older firmware: "heat" means manual setpoint there, the controls would do something else (audit K5)
    this.shadowRoot.querySelectorAll("#ctrl,details").forEach((el) => el.classList.toggle("locked", oldFw));
    $("minus").disabled = $("plus").disabled = oldFw || c.state === "off" || c.state === "unavailable";
    $("cur").textContent = a.current_temperature === null || a.current_temperature === undefined ? "–" : fmt(a.current_temperature) + "°";
    const s = x2State(c);
    $("act").textContent = s[0];
    $("act").className = "chip " + s[1];
    if (this._pendingSet == null) $("set").textContent = c.state === "off" ? "Aus" : fmt(a.temperature) + " °C";
    const off = c.state === "off", manual = isManual(a);
    $("modeInfo").textContent = off ? "ausgeschaltet" : manual ? "manueller Sollwert"
      : isTemporary(a) ? "vorübergehend geändert bis 0:00 Uhr, dann Wochenprogramm" : "nach Wochenprogramm";
    const preset = manual ? "Manuell" : "Wochenprogramm";
    $("ctrl").classList.toggle("off", off);
    this.shadowRoot.querySelectorAll("#hcSeg button").forEach((b) => b.classList.toggle("on", b.dataset.hc === (cooling ? "cool" : "heat")));
    this.shadowRoot.querySelectorAll("#prSeg button").forEach((b) => b.classList.toggle("on", b.dataset.pr === preset));
    $("pwr").classList.toggle("on", !off);

    // week program (kept while edited)
    const sch = e.schedule && e.schedule.attributes;
    if (sch && (!this._week || !this._weekDirty)) {
      this._week = DAYS.map((d) => {
        const v = parseInt(sch[d], 16) || 0;
        return { t: sch[d + "_Target_Temp"], h: Array.from({ length: 24 }, (_, i) => !!((v >> (23 - i)) & 1)) };
      });
    }
    $("ecoInfo").textContent = cfg.EcoTemperature !== undefined ? fmt(cfg.EcoTemperature) + " °C (Einstellungen)" : "–";
    if (this._week) {
      const t = this._week[(new Date().getDay() + 6) % 7];
      $("sum_week").textContent = (this._weekDirty ? "geändert · " : "heute ") + hourRanges(t.h) + " · " + fmt(t.t) + " °C";
    }
    this._drawWeek();

    // settings (kept while edited)
    const ae = this.shadowRoot.activeElement;
    const editing = !!ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT") && !!ae.closest("#s_set") && ae.id !== "lock";
    this._checkPending(cfg, sch);
    if (!this._cfgDirty && !editing) {
      $("reg").value = cfg.RegulationMode === "PI control" ? "PI control" : "normalClose";
      [...PARAMS, ...PI_PARAMS, ...VALVE_PARAMS].forEach((p) => {
        const v = cfg[p[0]];
        $("p_" + p[0]).value = v === undefined ? "" : String(v).replace(".", ",");
      });
      $("valve").checked = cfg.valveProtection !== false;
    }
    $("lock").checked = !!a.locked;
    $("sum_set").textContent = (cfg.RegulationMode === "PI control" ? "PI" : "Zweipunkt") + " · ECO " + fmt(cfg.EcoTemperature) + " °C"
      + (cfg.valveProtection !== false ? " · Ventilschutz" : "");
    this._updateSettingsVisibility();

    // statistics
    const st = e.stats && e.stats.attributes;
    if (st && Array.isArray(st.days)) {
      // numbers only: the attributes come from the broker (a retained message could carry markup, audit K1)
      const vals = st.days.slice(0, 7).reverse().concat([st.onToday]).map((v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0));
      const mx = Math.max(60, ...vals), today = new Date().getDay();
      $("bars").innerHTML = vals.map((v, i) => `<div class="${i === 7 ? "t" : ""}" style="height:${Math.max(3, Math.round((v / mx) * 100))}%" title="${esc(minShort(v))}"></div>`).join("");
      $("blab").innerHTML = vals.map((v, i) => `<span>${i === 7 ? "heute" : WD_JS[(today - (7 - i) + 70) % 7]}</span>`).join("");
      $("statInfo").textContent = `Gestern ${minShort(st.onYesterday)} · 7 Tage ${minShort(st.on7Days)} · ${st.relayCycles} Schaltspiele (ohne Ventilschutz)`;
      $("sum_stat").textContent = "heute " + minShort(st.onToday);
    } else {
      $("statInfo").textContent = "Keine Statistik (Firmware ab X2-V2.07)";
      $("sum_stat").textContent = "";
    }

    // device
    const upd = e.update && this._hass.states[e.update];
    const updOn = !!upd && upd.state === "on";
    $("dl").innerHTML = [
      ["Firmware", (cfg.firmware || "–") + (updOn ? " → " + (upd.attributes.latest_version || "neu") : "")],
      ["Relais", relayOn(a) ? "ein" : "aus"],
      ["WLAN", e.rssi ? e.rssi.state + " dBm" : "–"],
      ["Gerät", (dev.model || "ALM-X2") + (dev.hw_version ? " · " + dev.hw_version : "")],
      ["Karte", "alm-x2-card " + CARD_VERSION],
    ].map((r) => `<dt>${esc(r[0])}</dt><dd>${esc(r[1])}</dd>`).join("");
    $("sum_info").textContent = (cfg.firmware || "") + (updOn ? " · Update verfügbar" : "");
    $("upd").classList.toggle("hidden", !updOn);
    const url = dev.configuration_url;
    $("web").classList.toggle("hidden", !url);
    if (url) $("web").href = url;
  }

  _updateSettingsVisibility() {
    this.$("piParams").classList.toggle("hidden", this.$("reg").value !== "PI control");
    this.$("valveParams").classList.toggle("hidden", !this.$("valve").checked);
  }

  _readTemp() {
    if (!this._week) return;
    const v = parseNum(this.$("wTemp").value);
    if (!isNaN(v)) this._week[this._day].t = v;
  }

  _drawWeek() {
    const $ = this.$;
    this.shadowRoot.querySelectorAll("#days button").forEach((b) => b.classList.toggle("on", +b.dataset.d === this._day));
    if (!this._week) return;
    const d = this._week[this._day];
    if (this.shadowRoot.activeElement !== $("wTemp")) $("wTemp").value = d.t === undefined ? "" : String(d.t).replace(".", ",");
    this.shadowRoot.querySelectorAll("#hours button").forEach((b) => {
      b.classList.toggle("c", d.h[+b.dataset.h]);
      b.setAttribute("aria-pressed", d.h[+b.dataset.h] ? "true" : "false");
    });
  }

  _saveWeek() {
    if (!this._week) return;
    this._readTemp();
    const body = {};
    for (let i = 0; i < 7; i++) {
      const t = this._week[i].t;
      if (isNaN(t) || t < 20 || t > 40) return this._toast(`Komforttemperatur ${DAYS_DE[i]}: 20,0 bis 40,0 °C`, true);
      let v = 0;
      this._week[i].h.forEach((on, h) => { if (on) v |= 1 << (23 - h); });
      body[DAYS[i]] = v.toString(16).toUpperCase().padStart(6, "0");
      body[DAYS[i] + "_Target_Temp"] = Math.round(t * 10) / 10;
    }
    this._publish("schedules", body).then(() => this._expect("week", body)).catch(() => {});
  }

  _saveConfig() {
    const $ = this.$, cfg = (this._e.config && this._e.config.attributes) || {}, body = {};
    for (const p of [...PARAMS, ...PI_PARAMS, ...VALVE_PARAMS]) {
      const el = $("p_" + p[0]);
      if (el.closest(".hidden")) continue;
      const v = parseNum(el.value);
      if (isNaN(v) || v < p[2] - 1e-6 || v > p[3] + 1e-6 || (p[4] === 1 && !Number.isInteger(v)))
        return this._toast(`${p[1]}: ${fmt(p[2], p[4] < 1 ? 1 : 0)} bis ${fmt(p[3], p[4] < 1 ? 1 : 0)}`, true);
      const r = p[4] < 1 ? Math.round(v * 10) / 10 : v;
      if (cfg[p[0]] === undefined || r !== cfg[p[0]]) body[p[0]] = r;
    }
    if ($("reg").value !== cfg.RegulationMode) body.RegulationMode = $("reg").value;
    if ($("valve").checked !== (cfg.valveProtection !== false)) body.valveProtection = $("valve").checked;
    if (!Object.keys(body).length) { this._cfgDirty = false; return this._toast("Keine Änderung"); }
    this._publish("config", body).then(() => this._expect("cfg", body)).catch(() => {});
  }

  // a published command is confirmed when the device reports the values (MQTT status); otherwise a message after
  // 6 s - the device rejected it (tele/log) or is not reachable (audit K7)
  _expect(kind, body) {
    this._pending = this._pending || {};
    clearTimeout(this._pending[kind] && this._pending[kind].timer);
    this._toast("wird gespeichert …");
    this._pending[kind] = {
      body,
      timer: setTimeout(() => {
        if (!this._pending[kind]) return;
        delete this._pending[kind];
        if (kind === "cfg") this._cfgDirty = false; else this._weekDirty = false;
        this._toast("Das Gerät hat die Änderung nicht bestätigt", true);
        this._update();
      }, 6000),
    };
  }

  _checkPending(cfg, sch) {
    if (!this._pending) return;
    for (const [kind, src] of [["cfg", cfg], ["week", sch || {}]]) {
      const p = this._pending[kind];
      if (!p) continue;
      const same = Object.entries(p.body).every(([k, v]) => String(src[k]).toUpperCase().replace(/^0+(?=.)/, "") === String(v).toUpperCase().replace(/^0+(?=.)/, ""));
      if (!same) continue;
      clearTimeout(p.timer);
      delete this._pending[kind];
      if (kind === "cfg") this._cfgDirty = false; else this._weekDirty = false;
      this._toast(kind === "cfg" ? "Gespeichert" : "Wochenprogramm gespeichert");
    }
  }
}

// ---------------------------------------------------------------- overview of all ALM-X2

class AlmX2OverviewCard extends HTMLElement {
  static getStubConfig() {
    return { title: "Thermostate" };
  }

  static getConfigElement() {
    return document.createElement("alm-x2-overview-card-editor");
  }

  setConfig(config) {
    this._config = config || {};
    this._open = this._open || null;
    if (this._built) this._update();
  }

  getCardSize() {
    return 2 + this._list().length;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    this._update();
    if (this._detail) this._detail.hass = hass;
  }

  _list() {
    const h = this._hass;
    if (!h) return [];
    const ids = this._config.entities && this._config.entities.length ? this._config.entities
      : Object.keys(h.states).filter((e) => e.startsWith("climate.") && isX2(h, e));
    const name = (e) => {
      const reg = h.entities && h.entities[e], dev = reg && h.devices && h.devices[reg.device_id];
      return (dev && (dev.name_by_user || dev.name)) || (h.states[e] && h.states[e].attributes.friendly_name) || e;
    };
    return ids.filter((e) => h.states[e]).map((e) => ({ id: e, name: name(e) })).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }

  _build() {
    this._built = true;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}
 ha-card{padding:12px 12px 6px}
 .head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:2px 4px 8px}
 .head .title{font-size:16px}
 .item{border-top:1px solid var(--divider-color)}
 .r{display:grid;grid-template-columns:4px 1fr auto auto;align-items:center;gap:10px;padding:8px 4px}
 .bar{width:4px;height:34px;border-radius:2px;background:var(--x2-soft)}
 .bar.heat{background:var(--x2-heat)}.bar.cool{background:var(--x2-cool)}.bar.err{background:var(--error-color,#db4437)}.bar.valve{background:var(--x2-auto)}
 .nm{cursor:pointer;min-width:0}.nm .title{font-size:14px}.nm .sub{font-size:12px}
 .t{font-size:20px;font-weight:300;white-space:nowrap}
 .ctl{display:flex;align-items:center;gap:4px}
 .ctl .round{width:30px;height:30px;font-size:16px}.ctl .round ha-icon{--mdc-icon-size:18px}
 .ctl .v{min-width:52px;text-align:center;font-weight:600;font-size:14px}
 .ctl .round:disabled{opacity:.35;cursor:default}
 .detail{padding:0 0 8px}
 .detail alm-x2-card{display:block}
</style>
<ha-card><div class="head"><span class="title" id="title"></span><span class="sub" id="sum"></span></div><div id="rows"></div></ha-card>`;
    this._pending = {};
    this._timers = {};
    this.shadowRoot.getElementById("rows").addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches('[data-a="open"]')) { ev.preventDefault(); ev.target.click(); }
    });
    this.shadowRoot.getElementById("rows").onclick = (ev) => {
      const b = ev.target.closest("[data-a]");
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.a === "open") {
        this._open = this._open === id ? null : id;
        this._renderRows(true);
        return;
      }
      const c = this._hass.states[id];
      if (!c || c.state === "off") return;
      const base = this._pending[id] ?? c.attributes.temperature;
      this._pending[id] = Math.min(40, Math.max(10, Math.round((base + (b.dataset.a === "plus" ? 0.5 : -0.5)) * 10) / 10));
      this._renderRows();
      clearTimeout(this._timers[id]);
      this._timers[id] = setTimeout(() => {
        const v = this._pending[id];            // the value sent; a newer tap is kept (audit K2)
        if (v == null) return;
        this._hass.callService("climate", "set_temperature", { entity_id: id, temperature: v })
          .catch((e) => console.warn("ALM-X2:", e && e.message))
          .finally(() => setTimeout(() => { if (this._pending[id] === v) { delete this._pending[id]; this._renderRows(); } }, 2500));
      }, 800);
    };
  }

  _update() {
    if (!this._hass) return;
    const list = this._list(), h = this._hass;
    this.shadowRoot.getElementById("title").textContent = this._config.title || "Thermostate";
    const states = list.map((x) => h.states[x.id]);
    const temps = states.map((c) => c.attributes.current_temperature).filter((t) => typeof t === "number");
    const heating = states.filter((c) => c.attributes.hvac_action === "heating").length;
    const cooling = states.filter((c) => c.attributes.hvac_action === "cooling").length;
    const problems = states.filter((c) => c.state === "unavailable" || c.attributes.sensorError).length;
    this.shadowRoot.getElementById("sum").textContent = `${list.length} Geräte`
      + (heating ? ` · ${heating} heizen` : "") + (cooling ? ` · ${cooling} kühlen` : "")
      + (temps.length ? ` · Ø ${fmt(temps.reduce((a, b) => a + b, 0) / temps.length)} °C` : "")
      + (problems ? ` · ${problems} mit Störung` : "");
    this._renderRows();
  }

  _renderRows(structure) {
    const list = this._list(), h = this._hass, rows = this.shadowRoot.getElementById("rows");
    const key = list.map((x) => x.id).join(",") + "|" + this._open;
    if (structure || key !== this._key) {
      this._key = key;
      rows.innerHTML = list.map((x) => `<div class="item"><div class="r" data-row="${esc(x.id)}">
  <div class="bar"></div>
  <div class="nm" data-a="open" data-id="${esc(x.id)}" role="button" tabindex="0" aria-expanded="${this._open === x.id}"><div class="title"></div><div class="sub"></div></div>
  <div class="t"></div>
  <div class="ctl"><button class="round" data-a="minus" data-id="${esc(x.id)}" aria-label="Sollwert senken"><ha-icon icon="mdi:minus"></ha-icon></button><span class="v"></span><button class="round" data-a="plus" data-id="${esc(x.id)}" aria-label="Sollwert erhöhen"><ha-icon icon="mdi:plus"></ha-icon></button></div>
 </div>${this._open === x.id ? `<div class="detail" id="detail"></div>` : ""}</div>`).join("");
      // the open detail card is moved, not created again: unsaved input survives a new list order (audit K8)
      const keep = this._detail && this._detail._config && this._detail._config.entity === this._open ? this._detail : null;
      this._detail = null;
      if (this._open && list.some((x) => x.id === this._open)) {
        const d = keep || document.createElement("alm-x2-card");
        if (!keep) d.setConfig({ entity: this._open });
        d.hass = h;
        this.shadowRoot.getElementById("detail").appendChild(d);
        this._detail = d;
      }
    }
    for (const x of list) {
      const c = h.states[x.id], a = c.attributes, row = rows.querySelector(`[data-row="${CSS.escape(x.id)}"]`);
      if (!row) continue;
      const s = x2State(c);
      const cfgHc = (a.hvac_modes || []).includes("auto") ? "" : c.state === "cool" ? "Kühlen · " : c.state === "heat" ? "Heizen · " : "";
      const mode = c.state === "unavailable" ? "" : c.state === "off" ? "aus" : cfgHc + (isManual(a) ? "Manuell" : "Programm");
      row.querySelector(".bar").className = "bar " + s[1];
      row.querySelector(".title").textContent = x.name;
      row.querySelector(".sub").textContent = [s[1] === "off" ? "" : s[0], mode, a.locked ? "🔒" : ""].filter(Boolean).join(" · ");
      row.querySelector(".t").textContent = typeof a.current_temperature === "number" ? fmt(a.current_temperature) + "°" : "–";
      const p = this._pending[x.id];
      row.querySelector(".v").textContent = c.state === "unavailable" ? "–" : c.state === "off" ? "Aus" : fmt(p ?? a.temperature) + "°";
      row.querySelectorAll(".round").forEach((b) => (b.disabled = c.state === "unavailable" || c.state === "off"));
    }
  }
}

// ---------------------------------------------------------------- visual editors

class X2Editor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    this._render();
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => this.labels[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: ev.detail.value }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = this.schema;
  }
}
class AlmX2CardEditor extends X2Editor {
  get labels() { return { entity: "Thermostat (ALM-X2)", name: "Name (optional)" }; }
  get schema() { return [{ name: "entity", required: true, selector: { entity: { domain: "climate" } } }, { name: "name", selector: { text: {} } }]; }
}
class AlmX2OverviewCardEditor extends X2Editor {
  get labels() { return { title: "Titel", entities: "Thermostate (leer = alle ALM-X2)" }; }
  get schema() { return [{ name: "title", selector: { text: {} } }, { name: "entities", selector: { entity: { domain: "climate", multiple: true } } }]; }
}

customElements.define("alm-x2-card", AlmX2Card);
customElements.define("alm-x2-overview-card", AlmX2OverviewCard);
customElements.define("alm-x2-card-editor", AlmX2CardEditor);
customElements.define("alm-x2-overview-card-editor", AlmX2OverviewCardEditor);
window.customCards = window.customCards || [];
window.customCards.push(
  { type: "alm-x2-card", name: "ALM-X2 Thermostat", description: "Ein ALM-X2 mit allen Funktionen: Sollwert, Heizen/Kühlen, Wochenprogramm/Manuell, Ein/Aus, Wochenprogramm bearbeiten, Einstellungen, Einschaltdauer.", preview: true },
  { type: "alm-x2-overview-card", name: "ALM-X2 Übersicht", description: "Alle ALM-X2 kompakt in einer Liste; ein Raum lässt sich aufklappen.", preview: true },
);
console.info(`%c ALM-X2-CARD %c ${CARD_VERSION} `, "background:#d35400;color:#fff;border-radius:3px 0 0 3px", "background:#555;color:#fff;border-radius:0 3px 3px 0");
