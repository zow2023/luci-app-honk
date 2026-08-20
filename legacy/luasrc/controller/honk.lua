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
    local e = { running = false, version = "0.0.1-alpha", autostart = sys.init.enabled("honk") }
    
    -- 获取并校验 PID，避免额外的 cut 进程与安全隐患
    local raw_pid = sys.exec("pidof honk-core 2>/dev/null")
    local pid = raw_pid:match("(%d+)")
    
    if pid and pid:match("^%d+$") then
        e.running = true
        local status = fs.readfile("/proc/" .. pid .. "/status")
        if status then
            local rss = status:match("VmRSS:%s+(%d+)%s+kB")
            if rss then 
                e.memory = string.format("%.1f MB", tonumber(rss) / 1024) 
            end
        end
        
        -- 仅在 PID 校验通过后执行 ps 获取运行时间
        local uptime = sys.exec("ps -o etime= -p " .. pid .. " 2>/dev/null"):gsub("^%s+", ""):gsub("%s+$", "")
        if uptime ~= "" then
            e.uptime = uptime
        end
    end
    
    http.prepare_content("application/json")
    http.write_json(e)
end

function service_action()
    local action = http.formvalue("action")
    local code = -1

    if action == "autostart" then
        local value = http.formvalue("value") == "1" and "1" or "0"
        sys.call("uci set honk.config.enabled=" .. value)
        sys.call("uci commit honk")
        if value == "1" then 
            code = sys.call("/etc/init.d/honk enable >/dev/null 2>&1") 
        else 
            code = sys.call("/etc/init.d/honk disable >/dev/null 2>&1") 
        end
    elseif action == "start" then
        code = sys.call("/etc/init.d/honk start >/dev/null 2>&1")
    elseif action == "restart" then
        code = sys.call("/etc/init.d/honk restart >/dev/null 2>&1")
    elseif action == "stop" then
        code = sys.call("/etc/init.d/honk stop >/dev/null 2>&1")
    else
        http.status(400, "Bad Request")
        return
    end

    http.prepare_content("application/json")
    if code == 0 then
        http.write_json({ ok = true })
    else
        http.status(500, "Internal Server Error")
        http.write_json({ ok = false, code = code })
    end
end

function get_log() 
    http.prepare_content("text/plain; charset=utf-8")
    http.write(sys.exec("tail -n 1000 /var/log/honk/honk.log 2>/dev/null")) 
end

function clear_log() 
    local code = sys.call("true > /var/log/honk/honk.log")
    http.prepare_content("application/json")
    if code == 0 then
        http.write_json({ ok = true })
    else
        http.status(500, "Internal Server Error")
        http.write_json({ ok = false })
    end
end
