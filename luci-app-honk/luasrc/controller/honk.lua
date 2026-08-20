local sys = require "luci.sys"
local http = require "luci.http"
local nixio = require "nixio"

module("luci.controller.honk", package.seeall)

function index()
    if not nixio.fs.access("/etc/config/honk") then return end
    local page = entry({"admin", "services", "honk"}, template("honk/honk_status"), _("HONK"), 1)
    page.dependent = true
    page.acl_depends = { "luci-app-honk" }
    entry({"admin", "services", "honk", "status"}, call("act_status")).leaf = true
    entry({"admin", "services", "honk", "service_action"}, call("service_action")).leaf = true
    entry({"admin", "services", "honk", "global"}, cbi("honk/global"), _("Global Settings"), 2)
    entry({"admin", "services", "honk", "dns"}, cbi("honk/dns"), _("DNS Settings"), 3)
    entry({"admin", "services", "honk", "node"}, cbi("honk/node"), _("Node Settings"), 4)
    entry({"admin", "services", "honk", "route"}, cbi("honk/route"), _("Routing Settings"), 5)
    entry({"admin", "services", "honk", "log"}, cbi("honk/log"), _("Logs"), 6)
    entry({"admin", "services", "honk", "get_log"}, call("get_log")).leaf = true
    entry({"admin", "services", "honk", "clear_log"}, call("clear_log")).leaf = true
end

function act_status()
    local fs = require "nixio.fs"
    local e = { running = false, version = "0.0.1-alpha", autostart = luci.sys.init.enabled("honk") }
    local pid = sys.exec("pidof honk-core | cut -d' ' -f1"):gsub("\n", "")
    e.running = (pid ~= "")
    if e.running then
        local status = fs.readfile("/proc/" .. pid .. "/status")
        if status then
            local rss = status:match("VmRSS:%s+(%d+)%s+kB")
            if rss then e.memory = string.format("%.1f MB", tonumber(rss) / 1024) end
        end
        e.uptime = sys.exec("ps -o etime= -p " .. pid):gsub("^%s+", ""):gsub("%s+$", "")
    end
    http.prepare_content("application/json")
    http.write_json(e)
end

function service_action()
    local action = http.formvalue("action")
    if action == "autostart" then
        local value = http.formvalue("value") == "1" and "1" or "0"
        sys.call("uci set honk.config.enabled=" .. value)
        sys.call("uci commit honk")
        if value == "1" then sys.call("/etc/init.d/honk enable") else sys.call("/etc/init.d/honk disable") end
    elseif action == "start" then
        sys.call("/etc/init.d/honk start >/dev/null 2>&1")
    elseif action == "restart" then
        sys.call("/etc/init.d/honk restart >/dev/null 2>&1")
    elseif action == "stop" then
        sys.call("/etc/init.d/honk stop >/dev/null 2>&1")
    else
        http.status(400, "Bad Request")
        return
    end
    http.prepare_content("application/json")
    http.write_json({ ok = true })
end

function get_log() http.write(sys.exec("tail -n 1000 /var/log/honk/honk.log 2>/dev/null")) end
function clear_log() sys.call("true > /var/log/honk/honk.log") end
