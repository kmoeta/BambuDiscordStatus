# BambuDiscordStatus

Discord Rich Presence for a Bambu Lab printer, pulled live from Home Assistant. A Vencord userplugin. No separate script running on the PC, the plugin runs inside Discord and talks straight to HA over WebSocket.

What it shows, as `Watching <printer name>`:

- Printing: `Printing "Object Name"` and `62% · Layer 40/65 · PETG Basic · 41m left`, with Discord's own progress bar
- `Print finished`, `Print failed`, `Paused`
- `Printer error` when the printer reports an HMS or print error
- A Discord notification when a print finishes or fails
- When idle it rotates every 30 seconds through drying status, cooldown temps, last print, loaded filament, AMS humidity, and total print time
- Clears itself when the printer goes offline

## Requirements

- A Bambu Lab printer in Home Assistant via the [Bambu Lab integration](https://github.com/greghesp/ha-bambulab) (any Bambu model works, it exposes the same sensors)
- Vencord installed from source (the normal installer build can't load userplugins)
- A Discord application (free, takes two minutes)

## Setup

### 1. Discord app

https://discord.com/developers/applications → New Application, name it after your printer. Copy the **Application ID**.

Optional: in the app's Rich Presence → Art Assets, upload a printer image and a small icon. Right-click each thumbnail → Copy image address to get its numeric ID (Discord serves assets by numeric ID, not by name).

### 2. Home Assistant token

HA → your profile (bottom left) → Long-Lived Access Tokens → Create Token. Name it something like `Discord RPC` and copy it. The plugin only reads states, it never changes anything in HA.

### 3. Vencord source install

On the PC, in PowerShell:

```
git clone https://github.com/Vencord/Vencord
cd Vencord
pnpm install
pnpm build
pnpm inject
```

Needs Git, Node.js, and pnpm. `pnpm inject` patches your existing Discord install. (If PowerShell blocks `pnpm.ps1`, use `pnpm.cmd`.)

### 4. Install this plugin

- Copy the `BambuRPC` folder to `Vencord/src/userplugins/BambuRPC`
- `pnpm build` in the Vencord folder, restart Discord
- Discord Settings → Plugins → enable **BambuRPC**
- Fill in the settings:
  - **HA URL**: your Home Assistant WebSocket URL, e.g. `wss://homeassistant.local:8123/api/websocket`
  - **HA token**: the token from step 2
  - **Discord application ID**: from step 1
  - **Printer name**: shown in Discord, e.g. `My Printer`
  - **Printer entity prefix**: the part of your printer's entity IDs before `_print_status`. Find it in HA under Settings → Devices & Services → Entities, e.g. `my_printer` for `sensor.my_printer_print_status`
  - **AMS entity prefixes**: comma-separated prefixes for your AMS units, e.g. `my_ams_2_pro,my_ams_ht`. Leave empty if you have no AMS
  - **Large / small image**: the numeric asset IDs from step 1, if you uploaded art
  - **Notify on finish**: show a Discord notification when a print finishes or fails (on by default)
- Changing the printer or AMS prefixes needs a plugin restart (toggle it off and on) to take effect. Other settings apply live.

**First start:** a "Vencord Host Permissions" dialog will appear. Discord's Content Security Policy blocks connections to hosts that aren't on its allowlist, so the plugin asks Vencord to allow your HA host. Tick the "I fully trust" checkbox and click **Allow**, then relaunch Discord when asked. (This is Vencord's built-in permission flow, the same one its own MusicRichPresence plugin uses.)

## How it works

HA's REST API sends no `Access-Control-Allow-Origin` header, so `fetch()` from Discord's renderer is blocked by CORS. HA's WebSocket API has no origin check, so the plugin connects to the HA WebSocket, authenticates with the long-lived token, and gets live `state_changed` events. No polling.

Remaining time is computed from the print's `end_time` first, because the `remaining_time` sensor lags it. Idle cards that don't have their own timer count down to the next 30 second rotation swap. Discord always shows a timer on an activity, so there is no way to remove it entirely.

## Updating

- `git pull` + `pnpm build` in the Vencord folder, restart Discord.
- Updating Vencord does NOT remove the plugin: `src/userplugins/` is gitignored, so `git pull` leaves it alone and `pnpm build` rebuilds it into the new build. Same for Vencord's in-app updater.
- Two things that can break it: reinstalling Vencord with the normal installer instead of the source install (wipes the source folder, keep a copy of the plugin), and a future Vencord update changing the plugin API (the plugin would need a fix, not a reinstall). Discord itself updating can occasionally knock Vencord's injection out, just re-run `pnpm inject`.
- After editing the plugin, `pnpm build` + restart Discord for changes to take effect.

## Notes

- Presence only shows while Discord is running on your PC (it comes from the local client).
- If you play a game, Discord shows the game instead. The printer presence resumes when the game closes.
- Uses Discord's `LOCAL_ACTIVITY_UPDATE`, the same mechanism Vencord's built-in CustomRPC plugin uses.
- Works with any Bambu model and any number of AMS units (including none). Other brands won't work, their HA integrations expose different sensors.
