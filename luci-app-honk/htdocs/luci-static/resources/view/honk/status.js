// SPDX-License-Identifier: Apache-2.0

'use strict';
'require fs';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';

var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

var callHonkStats = rpc.declare({
    object: 'honk',
    method: 'getStats',
    params: [],
    expect: { '': {} }
});

function getInstanceInfo(serviceData) {
    try {
        var instance = serviceData.honk.instances.honk;
        return {
            running: !!instance.running,
            pid: instance.pid || null
        };
    } catch (e) {
        return { running: false, pid: null };
    }
}

function parseVersion(execResult) {
    var text = '';

    if (typeof execResult === 'string')
        text = execResult;
    else if (execResult && typeof execResult.stdout === 'string')
        text = execResult.stdout;

    text = (text || '').trim();
    if (!text)
        return '--';

    // 匹配 "honk-core 0.0.1-alpha" 或 "version 0.0.1" 等输出
    var match = text.match(/honk(?:-core)?\s+v?([^\s]+)/i) || text.match(/version\s+v?([^\s]+)/i);
    if (match && match[1])
        return match[1];

    var firstLine = text.split('\n')[0].trim();
    return firstLine || '--';
}

return view.extend({
    serviceEnabled: false,
    lastRx: 0,
    lastTx: 0,
    lastTime: 0,

    load: function () {
        var self = this;
        return Promise.all([
            uci.load('honk'),
            L.resolveDefault(callServiceList('honk'), {}),
            L.resolveDefault(fs.exec('/usr/bin/honk-core', ['--version']), null)
        ]).then(function (results) {
            return self.resolveWanInterfaces().then(function () {
                return results;
            });
        });
    },

    formatBytes: function (bytes) {
        if (bytes === 0 || isNaN(bytes) || bytes < 0) return '0 B';
        var k = 1024;
        var sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        if (i >= sizes.length) i = sizes.length - 1;
        return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
    },

    getMemoryUsage: function (pid) {
        if (!pid)
            return Promise.resolve('--');

        return L.resolveDefault(fs.read_direct('/proc/' + pid + '/status', 'text'), '').then(function (status) {
            var match = (status || '').match(/VmRSS:\s+(\d+)\s+kB/);
            return match ? (parseInt(match[1], 10) / 1024).toFixed(1) + ' MB' : '--';
        });
    },

    getUptime: function (pid) {
        if (!pid)
            return Promise.resolve('--');

        return Promise.all([
            L.resolveDefault(fs.read_direct('/proc/uptime', 'text'), ''),
            L.resolveDefault(fs.read_direct('/proc/' + pid + '/stat', 'text'), '')
        ]).then(function (results) {
            var systemUptime = parseFloat((results[0] || '').split(' ')[0]);
            var statParts = (results[1] || '').trim().split(/\s+/);

            if (!systemUptime || statParts.length < 22)
                return '--';

            var startTimeJiffies = parseFloat(statParts[21]);
            var processUptime = systemUptime - (startTimeJiffies / 100);

            if (isNaN(processUptime) || processUptime < 0)
                return '--';

            var hours = Math.floor(processUptime / 3600);
            var minutes = Math.floor((processUptime % 3600) / 60);
            var seconds = Math.floor(processUptime % 60);

            if (hours > 0)
                return hours + 'h ' + minutes + 'm ' + seconds + 's';
            if (minutes > 0)
                return minutes + 'm ' + seconds + 's';
            return seconds + 's';
        });
    },

    getTrafficStats: function () {
        return L.resolveDefault(callHonkStats(), null).then(function (res) {
            if (!res || typeof res.tx_bytes === 'undefined' || typeof res.rx_bytes === 'undefined')
                return { rx: 0, tx: 0 };
            return {
                rx: parseInt(res.rx_bytes, 10) || 0,
                tx: parseInt(res.tx_bytes, 10) || 0
            };
        });
    },

    resolveWanInterfaces: function () {
        var self = this;
        return L.resolveDefault(fs.read_direct('/etc/honk/config.dae', 'text'), '').then(function (raw) {
            var list = ['eth0', 'eth1', 'wan', 'br-wan'];
            var m = (raw || '').match(/^\s*wan_interface\s*:\s*([^\s]+)/m);
            if (m && m[1] && m[1] !== 'auto')
                list.unshift(m[1]);
            self.wanInterfaces = list;
            return list;
        });
    },

    execService: function (action) {
        return fs.exec('/etc/init.d/honk', [action]).then(function (res) {
            if (res && typeof res.code !== 'undefined' && res.code !== 0)
                return Promise.reject(new Error((res.stderr || res.stdout || (action + ' failed')).trim()));
            return res;
        });
    },

    setAutostart: function (enabled) {
        var self = this;

        uci.set('honk', 'config', 'enabled', enabled ? '1' : '0');

        return uci.save().then(function () {
            return uci.apply();
        }).then(function () {
            return self.execService(enabled ? 'enable' : 'disable');
        }).then(function () {
            self.serviceEnabled = enabled;
            return self.updateDashboard();
        }).catch(function (err) {
            ui.addNotification(null, E('p', _('Failed to update autostart: %s').format(err.message || err)), 'error');
            throw err;
        });
    },

    handleAction: function (action) {
        var self = this;

        if (action === 'start' && !self.serviceEnabled) {
            ui.addNotification(null,
                E('p', _('请先打开"开机自启"开关，再点击 启动。')),
                'warning');
            return Promise.resolve();
        }

        return self.execService(action).then(function () {
            return self.updateDashboard();
        }).catch(function (err) {
            var link = E('a', { href: L.url('admin/services/honk/log') }, _('查看日志'));
            ui.addNotification(null,
                E('p', _('服务操作失败：%s').format(err.message || err), link),
                'error');
            throw err;
        });
    },

    updateDashboard: function () {
        var self = this;

        var trafficPromise = self.getTrafficStats().catch(function () {
            return { rx: 0, tx: 0 };
        });

        return Promise.all([
            L.resolveDefault(callServiceList('honk'), {}),
            L.resolveDefault(fs.exec('/usr/bin/honk-core', ['--version']), null),
            trafficPromise
        ]).then(function (results) {
            var instanceInfo = getInstanceInfo(results[0]);
            var version = parseVersion(results[1]);
            var traffic = results[2];
            var autostart = uci.get('honk', 'config', 'enabled') === '1';

            self.serviceEnabled = autostart;

            return Promise.all([
                self.getMemoryUsage(instanceInfo.pid),
                self.getUptime(instanceInfo.pid)
            ]).then(function (metrics) {
                var badge = document.getElementById('honk_badge');
                var memory = document.getElementById('honk_memory');
                var uptime = document.getElementById('honk_uptime');
                var versionEl = document.getElementById('honk_version');
                var autostartEl = document.getElementById('honk_autostart');
                var rateEl = document.getElementById('honk_traffic_rate');
                var totalEl = document.getElementById('honk_traffic_total');

                if (badge) {
                    badge.innerHTML = '<span class="honk-dot"></span>' + (instanceInfo.running ? _('RUNNING') : _('NOT RUNNING'));
                    badge.style.background = instanceInfo.running ? '#173e2c' : '#4a2525';
                    badge.style.color = instanceInfo.running ? '#65d875' : '#ed6a63';
                }

                if (memory)
                    memory.textContent = instanceInfo.running ? metrics[0] : '--';
                if (uptime)
                    uptime.textContent = instanceInfo.running ? metrics[1] : '--';
                if (versionEl)
                    versionEl.textContent = version;
                if (autostartEl)
                    autostartEl.className = 'honk-switch' + (autostart ? ' on' : '');

                if (instanceInfo.running) {
                    var now = Date.now();
                    var timeDiff = self.lastTime ? (now - self.lastTime) / 1000 : 0;
                    var rxRate = 0, txRate = 0;

                    if (timeDiff > 0 && self.lastTime > 0) {
                        rxRate = Math.max(0, (traffic.rx - self.lastRx) / timeDiff);
                        txRate = Math.max(0, (traffic.tx - self.lastTx) / timeDiff);
                    }

                    self.lastRx = traffic.rx;
                    self.lastTx = traffic.tx;
                    self.lastTime = now;

                    if (rateEl)
                        rateEl.textContent = self.formatBytes(txRate) + '/s ↑ / ' + self.formatBytes(rxRate) + '/s ↓';
                    if (totalEl)
                        totalEl.textContent = self.formatBytes(traffic.tx) + ' ↑ / ' + self.formatBytes(traffic.rx) + ' ↓';
                } else {
                    self.lastRx = 0;
                    self.lastTx = 0;
                    self.lastTime = 0;
                    if (rateEl) rateEl.textContent = '0 B/s ↑ / 0 B/s ↓';
                    if (totalEl) totalEl.textContent = '0 B ↑ / 0 B ↓';
                }
            });
        });
    },

    render: function (data) {
        var self = this;
        var version = parseVersion(data[2]);
        self.serviceEnabled = uci.get('honk', 'config', 'enabled') === '1';

        var css = E('style', {}, '\
            .honk-dashboard{margin:0;padding:8px 0 24px} \
            .honk-dashboard *{box-sizing:border-box} \
            .honk-header{display:flex;align-items:center;justify-content:flex-start;gap:12px;margin-bottom:6px} \
            .honk-dashboard h1{margin:0;font-size:28px;line-height:1.1;color:#f59e0b} \
            .honk-description{margin:0 0 26px;color:var(--text-color-secondary,#666);font-size:14px} \
            .honk-badge{display:inline-flex;align-items:center;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700} \
            .honk-dot{display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:currentColor} \
            .honk-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:0 0 18px} \
            .honk-card{padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)} \
            .honk-label{color:var(--text-color-secondary,#666);font-size:13px;font-weight:700} \
            .honk-value{margin-top:12px;font-size:24px;font-weight:800;color:#20a965;word-break:break-all} \
            .honk-card.version .honk-value{color:inherit;font-size:18px} \
            .honk-bottom-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px} \
            .honk-section{padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)} \
            .honk-section h2{margin:0 0 16px;font-size:18px} \
            .honk-service{display:flex;align-items:center;gap:14px;margin-bottom:18px} \
            .honk-switch{position:relative;width:64px;height:34px;border:0;border-radius:999px;background:#777;cursor:pointer} \
            .honk-switch.on{background:#20bd68} \
            .honk-switch:after{content:"";position:absolute;top:4px;left:4px;width:26px;height:26px;border-radius:50%;background:#fff;transition:left .18s ease} \
            .honk-switch.on:after{left:34px} \
            .honk-actions{display:flex;flex-wrap:wrap;gap:10px} \
            .honk-traffic-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px} \
            .honk-subvalue{margin-top:8px;font-size:16px;font-weight:700;color:var(--text-color-primary,#333)} \
            @media(max-width:640px){.honk-cards,.honk-bottom-row,.honk-traffic-grid{grid-template-columns:1fr}}'
        );

        var viewEl = E('div', { 'class': 'honk-dashboard' }, [
            E('div', { 'class': 'honk-header' }, [
                E('h1', {}, 'HONK'),
                E('span', { 'id': 'honk_badge', 'class': 'honk-badge' }, [
                    E('span', { 'class': 'honk-dot' }),
                    _('Collecting data...')
                ])
            ]),
            E('p', { 'class': 'honk-description' }, _('基于 Rust eBPF 的高性能透明代理解决方案 (honk 引擎) 。')),
            E('section', { 'class': 'honk-cards' }, [
                E('div', { 'class': 'honk-card' }, [
                    E('div', { 'class': 'honk-label' }, _('Memory Usage')),
                    E('div', { 'id': 'honk_memory', 'class': 'honk-value' }, '--')
                ]),
                E('div', { 'class': 'honk-card' }, [
                    E('div', { 'class': 'honk-label' }, _('运行时间')),
                    E('div', { 'id': 'honk_uptime', 'class': 'honk-value' }, '--')
                ]),
                E('div', { 'class': 'honk-card version' }, [
                    E('div', { 'class': 'honk-label' }, _('引擎版本')),
                    E('div', { 'id': 'honk_version', 'class': 'honk-value' }, version)
                ])
            ]),
            E('div', { 'class': 'honk-bottom-row' }, [
                E('section', { 'class': 'honk-section' }, [
                    E('h2', {}, _('服务')),
                    E('div', { 'class': 'honk-service' }, [
                        E('button', {
                            'id': 'honk_autostart',
                            'class': 'honk-switch' + (self.serviceEnabled ? ' on' : ''),
                            'type': 'button',
                            'click': function () {
                                self.setAutostart(!self.serviceEnabled);
                            }
                        }),
                        E('span', {}, _('开机自启'))
                    ]),
                    E('div', { 'class': 'honk-actions' }, [
                        E('button', {
                            'class': 'btn cbi-button cbi-button-positive',
                            'type': 'button',
                            'click': function () { self.handleAction('start'); }
                        }, _('启动')),
                        E('button', {
                            'class': 'btn cbi-button cbi-button-apply',
                            'type': 'button',
                            'click': function () { self.handleAction('restart'); }
                        }, _('重启')),
                        E('button', {
                            'class': 'btn cbi-button cbi-button-negative',
                            'type': 'button',
                            'click': function () { self.handleAction('stop'); }
                        }, _('停止'))
                    ])
                ]),
                E('section', { 'class': 'honk-section' }, [
                    E('h2', {}, _('代理流量统计')),
                    E('div', { 'class': 'honk-traffic-grid' }, [
                        E('div', { 'class': 'honk-traffic-item' }, [
                            E('div', { 'class': 'honk-label' }, _('实时速率 (上/下)')),
                            E('div', { 'id': 'honk_traffic_rate', 'class': 'honk-subvalue' }, '0 B/s ↑ / 0 B/s ↓')
                        ]),
                        E('div', { 'class': 'honk-traffic-item' }, [
                            E('div', { 'class': 'honk-label' }, _('累计流量 (发/收)')),
                            E('div', { 'id': 'honk_traffic_total', 'class': 'honk-subvalue' }, '0 B ↑ / 0 B ↓')
                        ])
                    ])
                ])
            ])
        ]);

        self.updateDashboard();
        poll.add(function () {
            return self.updateDashboard();
        }, 3);

        return E('div', {}, [css, viewEl]);
    }
});
