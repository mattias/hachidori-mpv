-- SPDX-License-Identifier: GPL-3.0-or-later
-- hachidori-mpv: Hachidori lookups and Anki mining on mpv subtitles.
--
-- This script owns the mpv side: it opens a JSON IPC socket, starts the
-- overlay (an Electron app that runs the real Hachidori extension, linked to
-- the Hachidori in your browser through Sharing), hides mpv's own primary
-- subtitles while the overlay draws them, and gives you key bindings.

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
    screenshot_format = "webp",
    screenshot_height = 480,
    screenshot_quality = 80,
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
options.read_options(opts, "hachidori-mpv", function() publish_options() end)

local script_dir = mp.get_script_directory()
local overlay_dir = utils.join_path(script_dir, "overlay")
local is_windows = package.config:sub(1, 1) == "\\"

local state = {
    running = false,       -- the overlay told us it is attached to this mpv
    starting = false,
    last_heartbeat = 0,
    saved_sub_visibility = nil,
    disabled = false,      -- the user turned the overlay off for this mpv
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
-- again whenever it changes, so script-opts edits apply without a restart.
function publish_options()
    local copy = {}
    for key, value in pairs(opts) do copy[key] = value end
    copy.script_dir = script_dir
    copy.config_dir = mp.command_native({"expand-path", "~~/"})
    mp.set_property("user-data/hachidori-mpv/options", utils.format_json(copy))
end

local function hide_subs()
    if not opts.hide_mpv_subs or state.saved_sub_visibility ~= nil then return end
    state.saved_sub_visibility = mp.get_property_bool("sub-visibility", true)
    mp.set_property_bool("sub-visibility", false)
end

local function restore_subs()
    if state.saved_sub_visibility == nil then return end
    mp.set_property_bool("sub-visibility", state.saved_sub_visibility)
    state.saved_sub_visibility = nil
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
    restore_subs()
    osd("off")
end

local function has_subtitle_track()
    for _, track in ipairs(mp.get_property_native("track-list", {})) do
        if track.type == "sub" then return true end
    end
    return false
end

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
    hide_subs()
    if first then osd("ready", 1.5) end
end)

mp.register_script_message("hachidori-mpv-heartbeat", function()
    state.last_heartbeat = mp.get_time()
    if not state.running and not state.disabled then
        state.running = true
        state.starting = false
        hide_subs()
    end
end)

mp.register_script_message("hachidori-mpv-detached", function()
    state.running = false
    restore_subs()
end)

mp.register_script_message("hachidori-mpv-osd", function(text, seconds)
    osd(text, tonumber(seconds) or 3)
end)

-- A crashed or closed overlay sends no more heartbeats; bring mpv's own
-- subtitles back so nothing is lost.
mp.add_periodic_timer(2, function()
    if state.running and mp.get_time() - state.last_heartbeat > 6 then
        msg.warn("overlay stopped responding")
        state.running = false
        restore_subs()
    end
end)

mp.register_event("file-loaded", function()
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

mp.add_key_binding("alt+H", "settings", function()
    if not state.running then
        start_overlay()
        osd("starting… press again to open Settings once it is ready")
        return
    end
    mp.commandv("script-message", "hachidori-mpv-overlay", "settings")
end)

mp.add_key_binding(nil, "reload", function()
    mp.commandv("script-message", "hachidori-mpv-overlay", "reload")
end)

publish_options()
