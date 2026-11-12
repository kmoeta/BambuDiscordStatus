// BambuRPC: Discord Rich Presence for a Bambu Lab printer, via Home Assistant.
// Vencord userplugin. See README.md for setup.

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import definePlugin, { OptionType } from "@utils/types";
import { Alerts, FluxDispatcher } from "@webpack/common";

const logger = new Logger("BambuRPC");

const settings = definePluginSettings({
    haUrl: {
        type: OptionType.STRING,
        description: "Home Assistant WebSocket URL",
        default: "wss://ha.kitauji.dev/api/websocket",
    },
    haToken: {
        type: OptionType.STRING,
        description: "Home Assistant long-lived access token (read-only)",
        default: "",
    },
    appId: {
        type: OptionType.STRING,
        description: "Discord application ID (discord.com/developers/applications)",
        default: "1570146538343108729",
    },
    largeImage: {
        type: OptionType.STRING,
        description: "Large image asset ID (optional)",
        default: "",
    },
    smallImage: {
        type: OptionType.STRING,
        description: "Small image asset ID (optional)",
        default: "",
    },
    printerName: {
        type: OptionType.STRING,
        description: "Printer name shown in Discord",
        default: "Nakagawa",
    },
    printerPrefix: {
        type: OptionType.STRING,
        description: "Entity prefix for the printer, e.g. basement_nakagawa (the part before _print_status)",
        default: "basement_nakagawa",
    },
    amsPrefixes: {
        type: OptionType.STRING,
        description: "Comma-separated entity prefixes for AMS units, e.g. basement_ams_2_pro,basement_ams_ht. Empty for no AMS.",
        default: "basement_ams_2_pro,basement_ams_ht",
    },
});

const FINISH_TO_IDLE_MS = 10 * 60 * 1000;
const IDLE_ROTATE_MS = 30_000;

type States = Record<string, string | undefined>;

type AmsUnit = {
    label: string;
    drying: string | undefined;
    temp: string | undefined;
    humidity: string | undefined;
    remain: string | undefined;
    trays: (string | undefined)[];
};

type Card = { details: string; state: string; word: string; timestamps?: Record<string, number> };

// Entity IDs for the printer, built from the configured prefix.
function printerEntities(prefix: string): Record<string, string> {
    const s = (name: string) => `sensor.${prefix}_${name}`;
    const b = (name: string) => `binary_sensor.${prefix}_${name}`;
    return {
        status: s("print_status"),
        progress: s("print_progress"),
        task: s("task_name"),
        layer: s("current_layer"),
        total: s("total_layer_count"),
        remain: s("remaining_time"),
        end: s("end_time"),
        start: s("start_time"),
        online: b("online"),
        chamberTemp: s("chamber_temperature"),
        nozzleTemp: s("nozzle_temperature"),
        bedTemp: s("bed_temperature"),
        totalUsage: s("total_usage"),
        printWeight: s("print_weight"),
        printLength: s("print_length"),
    };
}

// One AMS unit's entity IDs, built from its prefix.
function amsEntities(prefix: string) {
    const s = (name: string) => `sensor.${prefix}_${name}`;
    const b = (name: string) => `binary_sensor.${prefix}_${name}`;
    return {
        label: amsLabel(prefix),
        drying: b("drying"),
        temp: s("temperature"),
        humidity: s("humidity"),
        remain: s("remaining_drying_time"),
        trays: [s("tray_1"), s("tray_2"), s("tray_3"), s("tray_4")],
    };
}

// "basement_ams_2_pro" -> "AMS 2 Pro", "basement_ams_ht" -> "AMS HT"
function amsLabel(prefix: string): string {
    const idx = prefix.lastIndexOf("ams_");
    const tail = idx >= 0 ? prefix.slice(idx + 4) : prefix;
    if (tail.toLowerCase() === "ams") return "AMS";
    const words = tail.split("_").filter(Boolean).map(w =>
        w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
    return words.length ? `AMS ${words.join(" ")}` : "AMS";
}

function fmtRemaining(minutes: number | undefined): string | null {
    if (minutes === undefined || isNaN(minutes) || minutes <= 0) return null;
    const h = Math.floor(minutes / 60), mm = Math.floor(minutes % 60);
    return h > 0 ? `${h}h ${mm}m left` : `${mm}m left`;
}

function fmtDuration(minutes: number | undefined): string | null {
    if (minutes === undefined || isNaN(minutes) || minutes <= 0) return null;
    const h = Math.floor(minutes / 60), mm = Math.round(minutes % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}

function shortFilament(s: string | undefined): string | null {
    if (!s || s === "unknown" || s === "unavailable" || s.toLowerCase() === "empty") return null;
    return s.replace(/^Bambu\s+/i, "").trim();
}

function isoToMs(s: string | undefined): number | undefined {
    if (!s || s === "unknown" || s === "unavailable") return undefined;
    const t = Date.parse(s);
    return isNaN(t) ? undefined : t;
}

// One idle card, picked by rotation index. Only cards with live data are
// offered; "Idle" is always last so there is always one.
function idleCard(s: States, ams: AmsUnit[], index: number): Card {
    const cards: Card[] = [];
    const num = (v: string | undefined) => { const n = parseFloat(v ?? ""); return isNaN(n) ? undefined : n; };

    // Drying. Carries a countdown (end = now + remaining time, rounded to
    // the minute so the end stays stable and dispatch dedupe keeps working).
    for (const unit of ams) {
        if (unit.drying !== "on") continue;
        const bits = [unit.label];
        const t = num(unit.temp); if (t !== undefined) bits.push(`${t}°C`);
        const r = num(unit.remain);
        let timestamps: Record<string, number> | undefined;
        if (r !== undefined && r > 0) {
            const d = fmtDuration(r * 60); if (d) bits.push(`${d} left`);
            timestamps = { end: Math.round((Date.now() + r * 3600000) / 60000) * 60000 };
        }
        cards.push({ details: "Drying filament", state: bits.join(" · "), word: "Drying", timestamps });
    }
    // Cooling down after a print.
    const nozzle = num(s.nozzleTemp), bed = num(s.bedTemp), chamber = num(s.chamberTemp);
    if ((nozzle !== undefined && nozzle > 40) || (bed !== undefined && bed > 40) || (chamber !== undefined && chamber > 30)) {
        const bits: string[] = [];
        if (nozzle !== undefined) bits.push(`Nozzle ${nozzle}°C`);
        if (bed !== undefined) bits.push(`Bed ${bed}°C`);
        if (chamber !== undefined) bits.push(`Chamber ${chamber}°C`);
        cards.push({ details: "Cooling down", state: bits.join(" · "), word: "Cooling down" });
    }
    // Last print recap.
    const task = (s.task ?? "").replace(/\.stl$/i, "").trim();
    if (task) {
        const bits: string[] = [];
        const start = isoToMs(s.start), end = isoToMs(s.end);
        if (start && end) { const d = fmtDuration((end - start) / 60000); if (d) bits.push(d); }
        const w = num(s.printWeight); if (w !== undefined) bits.push(`${w}g`);
        const l = num(s.printLength); if (l !== undefined) bits.push(`${l}m`);
        cards.push({ details: `Last print: ${task.slice(0, 100)}`, state: bits.join(" · ") || "Done", word: "Last print" });
    }
    // What's loaded (duplicates collapsed: "PLA Basic ×3").
    const trays = ams.flatMap(u => u.trays).map(shortFilament).filter((x): x is string => x !== null);
    if (trays.length) {
        const counts = new Map<string, number>();
        for (const t of trays) counts.set(t, (counts.get(t) ?? 0) + 1);
        const text = [...counts.entries()].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(" · ");
        cards.push({ details: "Filament loaded", state: text, word: "Filament" });
    }
    // Humidity for each AMS unit that isn't drying.
    for (const unit of ams) {
        if (unit.drying === "on") continue;
        const h = num(unit.humidity);
        if (h !== undefined) cards.push({ details: `${unit.label} humidity`, state: `${h}%`, word: "Humidity" });
    }
    // Lifetime stat.
    const usage = num(s.totalUsage);
    if (usage !== undefined) cards.push({ details: "Total print time", state: `${usage}h`, word: "Total" });
    // Always available.
    cards.push({ details: "Idle", state: "Ready to print", word: "Idle" });
    return cards[index % cards.length];
}

function buildActivity(s: States, ams: AmsUnit[], idleIndex: number, finishAt: number | undefined, rotateAt: number): Record<string, unknown> | "clear" | null {
    if (s.online === undefined && s.status === undefined) return null; // no data yet
    if (s.online === "off") return "clear";

    const status = (s.status ?? "unknown").toLowerCase();
    const task = (s.task ?? "Unknown print").replace(/\.stl$/i, "").trim().slice(0, 100);
    const progress = s.progress ?? "0";
    const start = isoToMs(s.start);
    const end = isoToMs(s.end);
    // Prefer end_time over the remaining_time sensor; the sensor lags it.
    const endMins = end !== undefined ? (end - Date.now()) / 60000 : parseFloat(s.remain ?? "");
    const remain = fmtRemaining(endMins);

    let card: Card;
    if (status === "running" || status === "prepare" || status === "slicing") {
        // Watching shows Discord's own progress bar from start+end, so the
        // state line is just the numbers.
        const bits = [`${progress}%`];
        if (s.layer && s.total && s.layer !== "unknown" && s.total !== "unknown")
            bits.push(`Layer ${s.layer}/${s.total}`);
        if (remain) bits.push(remain);
        const ts: Record<string, number> = {};
        if (start) ts.start = start;
        if (end) ts.end = end;
        card = { details: `Printing "${task}"`, state: bits.join(" · "), word: "Printing", timestamps: Object.keys(ts).length ? ts : undefined };
    } else if (status === "pause") {
        card = { details: `Paused — ${task}`, state: `${progress}% · Layer ${s.layer ?? "?"}/${s.total ?? "?"}`, word: "Paused" };
        if (start) card.timestamps = { start };
    } else if (status === "finish") {
        // 10 min after the print ends, stop bragging and join the idle rotation.
        const pastIdle = finishAt !== undefined && Date.now() - finishAt > FINISH_TO_IDLE_MS;
        card = pastIdle
            ? idleCard(s, ams, idleIndex)
            : { details: "Print finished", state: task, word: "Print finished" };
        // Rotation cards count down to the next swap; the fixed
        // "Print finished" card has no rotation, so it gets none.
        if (pastIdle && !card.timestamps) card.timestamps = { end: rotateAt };
    } else if (status === "failed" || status === "error") {
        card = { details: "Print failed", state: task, word: "Print failed" };
    } else if (status === "idle") {
        card = idleCard(s, ams, idleIndex);
        // Untimed rotation cards count down to the next 30s swap.
        // Drying cards keep their own countdown.
        if (!card.timestamps) card.timestamps = { end: rotateAt };
    } else {
        card = { details: `Nakagawa: ${status}`, state: task, word: status };
    }

    const base: Record<string, unknown> = {
        application_id: settings.store.appId,
        name: settings.store.printerName,
        type: 3, // Watching
        details: card.details,
        state: card.state,
    };
    if (card.timestamps) base.timestamps = card.timestamps;
    else base.timestamps = null;
    const assets: Record<string, unknown> = {};
    if (settings.store.largeImage) {
        assets.large_image = settings.store.largeImage;
        assets.large_text = settings.store.printerName;
    }
    if (settings.store.smallImage) {
        assets.small_image = settings.store.smallImage;
        assets.small_text = card.word;
    }
    if (Object.keys(assets).length) base.assets = assets;
    return base;
}

export default definePlugin({
    name: "BambuRPC",
    description: "Discord Rich Presence for a Bambu Lab printer, pulled live from Home Assistant.",
    authors: [{ name: "kmoeta", id: 0n }],
    settings,

    ws: null as WebSocket | null,
    msgId: 1,
    states: {} as States,
    reconnectTimer: null as ReturnType<typeof setTimeout> | null,
    reconnectDelay: 5000,
    authFailed: false,
    idleTimer: null as ReturnType<typeof setInterval> | null,
    rotateTimerStartedAt: 0,
    idleIndex: 0,
    finishSince: null as number | null,
    lastActivityJson: "",
    started: false,
    printer: {} as Record<string, string>,
    ams: [] as ReturnType<typeof amsEntities>[],
    watched: new Set<string>(),

    start() {
        this.started = true;
        this.authFailed = false;
        this.reconnectDelay = 5000;
        if (!settings.store.appId || !settings.store.haToken) {
            logger.warn("Set your Discord application ID and HA token in the plugin settings first.");
            return;
        }
        this.buildEntities();
        if (this.idleTimer) clearInterval(this.idleTimer);
        this.rotateTimerStartedAt = Date.now();
        this.idleTimer = setInterval(() => {
            if (this.isIdleish()) { this.idleIndex++; this.refresh(); }
        }, IDLE_ROTATE_MS);
        this.ensureCspAndConnect();
    },

    stop() {
        this.started = false;
        if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) { try { this.ws.close(); } catch { /* already closed */ } this.ws = null; }
        this.pushActivity("clear");
    },

    // Entity IDs come from the printer and AMS prefixes in settings.
    // Changing them needs a plugin restart to take effect.
    buildEntities() {
        const printerPrefix = settings.store.printerPrefix.trim() || "basement_nakagawa";
        const amsPrefixes = settings.store.amsPrefixes.split(",").map(p => p.trim()).filter(Boolean);
        this.printer = printerEntities(printerPrefix);
        this.ams = amsPrefixes.map(amsEntities);
        this.watched = new Set([
            ...Object.values(this.printer),
            ...this.ams.flatMap(a => [a.drying, a.temp, a.humidity, a.remain, ...a.trays]),
        ]);
    },

    // HA's WebSocket API has no origin check, unlike its REST API, so this
    // works from Discord's renderer where fetch() would be CORS-blocked.
    // Discord's CSP still blocks the host until Vencord allows it (first start).
    async ensureCspAndConnect() {
        const origin = (() => {
            try {
                const u = new URL(settings.store.haUrl);
                return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
            } catch { return "https://ha.kitauji.dev"; }
        })();
        if (await VencordNative.csp.isDomainAllowed(origin, ["connect-src"])) {
            this.connect();
            return;
        }
        const res = await VencordNative.csp.requestAddOverride(origin, ["connect-src"], "BambuRPC");
        if (res === "ok") {
            Alerts.show({
                title: "Permission added",
                body: "Discord must be relaunched for the new permission to take effect. Relaunch now?",
                confirmText: "Relaunch",
                cancelText: "Later",
                onConfirm: relaunch,
            });
            return;
        }
        Alerts.show({
            title: "BambuRPC needs permission to reach Home Assistant",
            body: `Discord blocks the connection to ${origin} until you allow it. Click Retry to show the permission prompt again.`,
            confirmText: "Retry",
            cancelText: "Cancel",
            onConfirm: () => this.ensureCspAndConnect(),
        });
    },

    connect() {
        if (!this.started || this.authFailed) return;
        // Close any live socket and clear any pending reconnect timer first,
        // so a second connect() can't orphan the old socket.
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
        logger.info("Connecting to Home Assistant…");
        const ws = new WebSocket(settings.store.haUrl);
        this.ws = ws;

        ws.onopen = () => logger.info("WebSocket open, waiting for auth_required…");

        ws.onmessage = (ev: MessageEvent) => {
            let msg: any;
            try { msg = JSON.parse(ev.data); } catch { return; }

            if (msg.type === "auth_required") {
                ws.send(JSON.stringify({ type: "auth", access_token: settings.store.haToken }));
                return;
            }
            if (msg.type === "auth_ok") {
                logger.info("Authenticated with Home Assistant.");
                this.reconnectDelay = 5000;
                ws.send(JSON.stringify({ type: "get_states", id: this.msgId++ }));
                ws.send(JSON.stringify({ type: "subscribe_events", event_type: "state_changed", id: this.msgId++ }));
                return;
            }
            if (msg.type === "auth_invalid") {
                // HA closes the socket after auth_invalid; retrying a dead
                // token forever is a busy loop, so stop here.
                logger.error("HA rejected the token. Check the token in plugin settings, then toggle the plugin off and on.");
                this.authFailed = true;
                try { ws.close(); } catch { /* ignore */ }
                return;
            }
            if (msg.type === "result" && msg.success && Array.isArray(msg.result)) {
                for (const st of msg.result) {
                    if (this.watched.has(st.entity_id))
                        this.states[st.entity_id] = st.state;
                }
                this.refresh();
                return;
            }
            if (msg.type === "event" && msg.event?.event_type === "state_changed") {
                const data = msg.event.data;
                if (data?.entity_id && this.watched.has(data.entity_id)) {
                    this.states[data.entity_id] = data.new_state?.state;
                    this.refresh();
                }
                return;
            }
        };

        ws.onerror = () => logger.warn("WebSocket error, will retry…");

        ws.onclose = () => {
            if (this.ws === ws) this.ws = null;
            if (!this.started || this.authFailed) return;
            const delay = this.reconnectDelay;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
            logger.info(`WebSocket closed, reconnecting in ${delay / 1000}s…`);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        };
    },

    // True when the presence is showing (or should show) an idle card:
    // actually idle, or finished more than 10 min ago.
    isIdleish() {
        const status = (this.states[this.printer.status] ?? "").toLowerCase();
        if (status === "idle") return true;
        if (status !== "finish") return false;
        const finishAt = isoToMs(this.states[this.printer.end]) ?? this.finishSince ?? undefined;
        return finishAt !== undefined && Date.now() - finishAt > FINISH_TO_IDLE_MS;
    },

    refresh() {
        const status = (this.states[this.printer.status] ?? "").toLowerCase();
        if (status === "finish" && this.finishSince === null) this.finishSince = Date.now();
        if (status !== "finish") this.finishSince = null;
        const short: States = {};
        for (const [key, entityId] of Object.entries(this.printer))
            short[key] = this.states[entityId];
        const amsUnits: AmsUnit[] = this.ams.map(a => ({
            label: a.label,
            drying: this.states[a.drying],
            temp: this.states[a.temp],
            humidity: this.states[a.humidity],
            remain: this.states[a.remain],
            trays: a.trays.map(t => this.states[t]),
        }));
        const finishAt = isoToMs(short.end) ?? this.finishSince ?? undefined;
        // Next rotation tick on the 30s interval's schedule (anchored to
        // when it was created). Untimed rotation cards count down to it.
        // Stable between ticks, so the dispatch dedupe still holds.
        if (!this.rotateTimerStartedAt) this.rotateTimerStartedAt = Date.now();
        const elapsed = Date.now() - this.rotateTimerStartedAt;
        const rotateAt = this.rotateTimerStartedAt + (Math.floor(elapsed / IDLE_ROTATE_MS) + 1) * IDLE_ROTATE_MS;
        this.pushActivity(buildActivity(short, amsUnits, this.idleIndex, finishAt, rotateAt));
    },

    pushActivity(activity: Record<string, unknown> | "clear" | null) {
        if (activity === null) return; // no data yet: leave presence alone
        const json = JSON.stringify(activity);
        if (json === this.lastActivityJson) return; // unchanged: don't spam dispatch
        this.lastActivityJson = json;
        FluxDispatcher.dispatch({
            type: "LOCAL_ACTIVITY_UPDATE",
            activity: activity === "clear" ? null : activity,
            socketId: "BambuRPC",
        });
    },
});
