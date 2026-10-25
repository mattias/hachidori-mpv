-- SPDX-License-Identifier: GPL-3.0-or-later
-- hachidori-mpv: Hachidori lookups and Anki mining on mpv subtitles.
--
-- This script owns the mpv side: it opens a JSON IPC socket, starts the
-- overlay (an Electron app that runs the real Hachidori extension, linked to
-- the Hachidori in your browser through Sharing), hides mpv's own primary
-- subtitles while the overlay draws them, and gives you key bindings:
-- subtitle navigation and line repeat while the overlay is on.

local mp = require "mp"
local msg = require "mp.msg"
local utils = require "mp.utils"
local options = require "mp.options"

local opts = {
    -- Start the overlay by itself when a file with a subtitle track loads.
    autostart = true,
    -- Hide mpv's primary subtitles while the overlay draws them.
    hide_mpv_subs = true,
    -- Pause while the pointer is over a subtitle or a popup is open.
    pause_on_hover = true,
    -- Link to the sharing Hachidori on this computer the first time.
    auto_link = true,
    -- Keys while the overlay is on. Empty turns one off.
    key_prev_sub = "LEFT",
    key_next_sub = "RIGHT",
    key_repeat = "r",
    -- Subtitle appearance in the overlay. Sizes are percentages of the
    -- video window's height.
    font_family = "Noto Sans CJK JP, Noto Sans JP, Yu Gothic UI, Meiryo, Hiragino Sans, sans-serif",
    font_size = 5.6,
    font_weight = 600,
    font_color = "#ffffff",
    outline_color = "#000000",
    outline_size = 0.28,
    background_color = "transparent",
    bottom_margin = 5.5,
    max_width = 90,
    -- Anki media. Hachidori fills every other field from your Template; mpv
    -- fills the {screenshot}/{gif} and {sentence-audio} fields it cannot.
    fill_screenshot = true,
    fill_sentence_audio = true,
    -- The still picture: the frame on screen when you mine.
    screenshot_format = "webp",
    screenshot_height = 480,
    screenshot_quality = 80,
    -- An animated picture instead, as Anki Miner makes it: a clip from the
    -- subtitle's start, at most the subtitle long (0 = the sentence audio's
    -- span, as screenshot_animated_match_audio).
    screenshot_animated = false,
    screenshot_animated_format = "avif",
    screenshot_animated_clip_duration = 2.0,
    screenshot_animated_match_audio = false,
    screenshot_animated_fps = 20,
    screenshot_animated_height = 720,
    screenshot_animated_quality = 30,
    audio_format = "opus",
    audio_bitrate = "64k",
    audio_pad_start = 0.15,
    audio_pad_end = 0.25,
    -- Field names that override the Template's own {screenshot} and
    -- {sentence-audio} fields. Empty means "use the Template".
    screenshot_field = "",
    sentence_audio_field = "",
    -- Empty means: ffmpeg next to mpv, then ffmpeg on PATH.
    ffmpeg_path = "",
    -- Empty means: the AnkiConnect address Hachidori uses.
    ankiconnect_url = "",
    ankiconnect_key = "",
    -- The Hachidori Relay's Yomitan-compatible API, used to read your Anki
    -- Templates (Relay v0.0.5 or newer).
    relay_api_url = "http://127.0.0.1:19633",
    -- Empty means: the Electron the installer put in overlay/node_modules.
    electron_path = "",
    -- Show the overlay's developer tools (for debugging).
    debug = false,
}
local defaults = {}
for key, value in pairs(opts) do defaults[key] = value end

local script_dir = mp.get_script_directory()
local overlay_dir = utils.join_path(script_dir, "overlay")
local is_windows = package.config:sub(1, 1) == "\\"

local state = {
    running = false,       -- the overlay told us it is attached to this mpv
    starting = false,
    last_heartbeat = 0,
    saved_sub_visibility = nil,
    disabled = false,      -- the user turned the overlay off for this mpv
    keys_bound = false,
    repeat_line = nil,     -- {start, stop} while a line repeats
    pending_repeat = false,
    last_line = nil,       -- the last subtitle line seen, for repeat between lines
}

local function osd(text, seconds)
    mp.osd_message("Hachidori: " .. text, seconds or 3)
end

local function file_exists(path)
    local info = utils.file_info(path)
    return info ~= nil and info.is_file
end

local function electron_executable()
    if opts.electron_path ~= "" then return opts.electron_path end
    local dist = utils.join_path(overlay_dir, "node_modules/electron/dist")
    if is_windows then return utils.join_path(dist, "electron.exe") end
    local mac = utils.join_path(dist, "Electron.app/Contents/MacOS/Electron")
    if file_exists(mac) then return mac end
    return utils.join_path(dist, "electron")
end

local function ipc_path()
    local current = mp.get_property("input-ipc-server", "")
    if current ~= "" then return current end
    local pid = mp.get_property("pid", tostring(os.time()))
    local path
    if is_windows then
        path = "\\\\.\\pipe\\hachidori-mpv-" .. pid
    else
        local dir = os.getenv("XDG_RUNTIME_DIR") or "/tmp"
        path = dir .. "/hachidori-mpv-" .. pid .. ".sock"
    end
    mp.set_property("input-ipc-server", path)
    return mp.get_property("input-ipc-server", path)
end

-- The overlay reads its settings from this property when it attaches and
-- again whenever it changes, so edits apply without a restart.
local function publish_options()
    local copy = {}
    for key, value in pairs(opts) do copy[key] = value end
    copy.script_dir = script_dir
    copy.config_dir = mp.command_native({"expand-path", "~~/"})
    copy.defaults = defaults
    mp.set_property("user-data/hachidori-mpv/options", utils.format_json(copy))
end

-- force: the overlay (re)attached, so mpv's subtitles go away again even if
-- they were turned back on (with v) in the meantime.
local function hide_subs(force)
    if not opts.hide_mpv_subs then return end
    if state.saved_sub_visibility ~= nil then
        if force then mp.set_property_bool("sub-visibility", false) end
        return
    end
    state.saved_sub_visibility = mp.get_property_bool("sub-visibility", true)
    mp.set_property_bool("sub-visibility", false)
end

local function restore_subs()
    if state.saved_sub_visibility == nil then return end
    mp.set_property_bool("sub-visibility", state.saved_sub_visibility)
    state.saved_sub_visibility = nil
end

-- Repeat: mpv's own A-B loop over the line, padded like the sentence audio.

local function publish_repeat()
    mp.set_property("user-data/hachidori-mpv/repeat", state.repeat_line and "yes" or "no")
end

local function current_line()
    local start = mp.get_property_number("sub-start")
    local stop = mp.get_property_number("sub-end")
    if start and stop and stop > start then return {start = start, stop = stop} end
    return nil
end

local function loop_line(line, seek)
    local a = math.max(0, line.start - (tonumber(opts.audio_pad_start) or 0))
    local b = line.stop + (tonumber(opts.audio_pad_end) or 0)
    state.repeat_line = line
    mp.set_property_number("ab-loop-a", a)
    mp.set_property_number("ab-loop-b", b)
    if seek then mp.commandv("seek", tostring(a), "absolute+exact") end
    publish_repeat()
end

local function stop_repeat(quiet)
    if not state.repeat_line and not state.pending_repeat then return end
    state.repeat_line = nil
    state.pending_repeat = false
    mp.set_property("ab-loop-a", "no")
    mp.set_property("ab-loop-b", "no")
    publish_repeat()
    if not quiet then osd("repeat off", 1.5) end
end

local function toggle_repeat()
    if state.repeat_line then
        stop_repeat(false)
        return
    end
    local line = current_line() or state.last_line
    if not line then
        osd("no subtitle line to repeat", 2)
        return
    end
    loop_line(line, true)
    osd("repeat on", 1.5)
end

-- Previous/next subtitle. A repeating line moves with you: the loop is
-- cleared before the seek, so mpv does not jump back, and set again on the
-- new line once playback restarts there.
local function sub_step(direction)
    if not has_subtitle_track() then
        mp.commandv("seek", tostring(5 * direction))
        return
    end
    if state.repeat_line then
        state.repeat_line = nil
        state.pending_repeat = true
        mp.set_property("ab-loop-a", "no")
        mp.set_property("ab-loop-b", "no")
    end
    mp.commandv("no-osd", "sub-seek", tostring(direction))
end

mp.register_event("playback-restart", function()
    if not state.pending_repeat then return end
    state.pending_repeat = false
    local line = current_line()
    if line then loop_line(line, false) else publish_repeat() end
end)

function has_subtitle_track()
    for _, track in ipairs(mp.get_property_native("track-list", {})) do
        if track.type == "sub" then return true end
    end
    return false
end

local function bind_keys()
    if state.keys_bound then return end
    state.keys_bound = true
    local function bind(key, name, fn)
        if key and key ~= "" then mp.add_forced_key_binding(key, name, fn, {repeatable = true}) end
    end
    bind(opts.key_prev_sub, "hachidori-mpv-prev-sub", function() sub_step(-1) end)
    bind(opts.key_next_sub, "hachidori-mpv-next-sub", function() sub_step(1) end)
    if opts.key_repeat ~= "" then mp.add_forced_key_binding(opts.key_repeat, "hachidori-mpv-repeat", toggle_repeat) end
end

local function unbind_keys()
    if not state.keys_bound then return end
    state.keys_bound = false
    for _, name in ipairs({"hachidori-mpv-prev-sub", "hachidori-mpv-next-sub", "hachidori-mpv-repeat"}) do
        mp.remove_key_binding(name)
    end
end

local function rebind_keys()
    if not state.keys_bound then return end
    unbind_keys()
    bind_keys()
end

local function on_overlay_running(attached)
    hide_subs(attached)
    bind_keys()
end

local function on_overlay_stopped()
    restore_subs()
    unbind_keys()
    stop_repeat(true)
end

local function start_overlay()
    if state.running or state.starting then return end
    local electron = electron_executable()
    if not file_exists(electron) then
        osd("the overlay is not installed. Run install.ps1 / install.sh from hachidori-mpv.", 6)
        msg.error("Electron not found at " .. electron)
        return
    end
    state.disabled = false
    state.starting = true
    publish_options()
    local args = {electron, overlay_dir, "--mpv-ipc=" .. ipc_path()}
    if opts.debug then table.insert(args, "--hachidori-debug") end
    msg.info("starting overlay: " .. table.concat(args, " "))
    mp.command_native_async({
        name = "subprocess",
        args = args,
        detach = true,
        playback_only = false,
        capture_stdout = false,
        capture_stderr = false,
    }, function() end)
    -- The overlay attaches within a few seconds; say so if it never does.
    mp.add_timeout(20, function()
        if state.starting and not state.running then
            state.starting = false
            osd("the overlay did not start. Run mpv from a terminal and look for [hachidori_mpv] lines.", 6)
        end
    end)
end

local function stop_overlay()
    state.disabled = true
    mp.commandv("script-message", "hachidori-mpv-overlay", "detach")
    state.running = false
    state.starting = false
    on_overlay_stopped()
    osd("off")
end

options.read_options(opts, "hachidori-mpv", function()
    publish_options()
    rebind_keys()
end)

-- Messages from the overlay.
mp.register_script_message("hachidori-mpv-attached", function()
    local first = not state.running
    state.running = true
    state.starting = false
    state.last_heartbeat = mp.get_time()
    if state.disabled then
        mp.commandv("script-message", "hachidori-mpv-overlay", "detach")
        return
    end
    on_overlay_running(true)
    if first then osd("ready", 1.5) end
end)

mp.register_script_message("hachidori-mpv-heartbeat", function()
    state.last_heartbeat = mp.get_time()
    if not state.running and not state.disabled then
        state.running = true
        state.starting = false
        on_overlay_running()
    end
end)

mp.register_script_message("hachidori-mpv-detached", function()
    state.running = false
    on_overlay_stopped()
end)

mp.register_script_message("hachidori-mpv-osd", function(text, seconds)
    osd(text, tonumber(seconds) or 3)
end)

-- A setting changed in the plugin's Settings window (already saved to
-- script-opts/hachidori-mpv.conf): apply it now.
mp.register_script_message("hachidori-mpv-set", function(key, value)
    if opts[key] == nil then return end
    local kind = type(defaults[key])
    if kind == "boolean" then
        opts[key] = value == "yes" or value == "true"
    elseif kind == "number" then
        opts[key] = tonumber(value) or defaults[key]
    else
        opts[key] = value
    end
    if key == "hide_mpv_subs" and state.running then
        if opts.hide_mpv_subs then hide_subs() else restore_subs() end
    end
    if key:sub(1, 4) == "key_" then rebind_keys() end
    publish_options()
end)

mp.register_script_message("hachidori-mpv-publish", function()
    publish_options()
end)

-- A crashed or closed overlay sends no more heartbeats; bring mpv's own
-- subtitles and keys back so nothing is lost.
mp.add_periodic_timer(2, function()
    if state.running and mp.get_time() - state.last_heartbeat > 6 then
        msg.warn("overlay stopped responding")
        state.running = false
        on_overlay_stopped()
    end
end)

mp.observe_property("sub-end", "number", function()
    local line = current_line()
    if line then state.last_line = line end
end)

mp.register_event("file-loaded", function()
    stop_repeat(true)
    state.last_line = nil
    if opts.autostart and not state.disabled and not state.running and has_subtitle_track() then
        start_overlay()
    end
end)

mp.register_event("shutdown", function()
    mp.commandv("script-message", "hachidori-mpv-overlay", "detach")
end)

mp.add_key_binding("alt+h", "toggle", function()
    if state.running or state.starting then stop_overlay() else start_overlay() end
end)

local function overlay_command(command)
    return function()
        if not state.running then
            start_overlay()
            osd("starting… press again once it is ready")
            return
        end
        mp.commandv("script-message", "hachidori-mpv-overlay", command)
    end
end

mp.add_key_binding("alt+H", "settings", overlay_command("settings"))
mp.add_key_binding("alt+o", "plugin-settings", overlay_command("plugin-settings"))
mp.add_key_binding(nil, "repeat", toggle_repeat)
mp.add_key_binding(nil, "reload", function()
    mp.commandv("script-message", "hachidori-mpv-overlay", "reload")
end)

publish_options()
publish_repeat()
