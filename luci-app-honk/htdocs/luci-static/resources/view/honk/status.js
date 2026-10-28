// SPDX-License-Identifier: Apache-2.0

'use strict';

'require dom';
'require fs';
'require poll';
'require rpc';
'require uci';
'require ui';
'require view';
'require honk.dashprofiles as dash';

var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

var callHonkStats = rpc.declare({
    object: 'honk',
    method: 'getStats',
    // [fix] 移除无意义的空 params 数组，rpc.declare 默认即为无参
    expect: { '': {} }
});

/* ---- Web panel (ported from QiuSimons/luci-app-honk) ---- */

var callPanelInfo = rpc.declare({
    object: 'honk',
    method: 'get_dashboard_info',
    params: ['type'],
    expect: { '': {} }
});

var callPanelDownload = rpc.declare({
    object: 'honk',
    method: 'download_dashboard',
    params: ['url', 'type'],
    expect: { '': {} }
});

var callPanelDownloadStatus = rpc.declare({
    object: 'honk',
    method: 'download_status',
    expect: { '': {} }
});

var callPanelSwitch = rpc.declare({
    object: 'honk',
    method: 'switch_dashboard_api',
    params: ['type'],
    expect: { '': {} }
});

function getInstanceInfo(serviceData) {
    try {
        var instances = serviceData && serviceData.honk && serviceData.honk.instances;
        if (!instances)
            return { running: false, pid: null };

        var key = instances.honk ? 'honk' : Object.keys(instances)[0];
        var instance = key ? instances[key] : null;

        return {
            running: !!(instance && instance.running),
            pid: instance && instance.pid ? instance.pid : null
        };
    }
    catch (e) {
        // [fix] 静默吞掉异常时补充 warn 日志，便于排查问题
        console.warn('[honk] getInstanceInfo error:', e);
        return { running: false, pid: null };
    }
}

function parseVersion(execResult) {
    var text = typeof execResult === 'string' ? execResult :
        (execResult && typeof execResult.stdout === 'string' ? execResult.stdout : '');

    text = text.trim();
    if (!text)
        return '--';

    var match = text.match(/honk(?:-core)?\s+v?([^\s]+)/i) ||
        text.match(/version\s+v?([^\s]+)/i);

    return match ? match[1] : (text.split(/\r?\n/)[0].trim() || '--');
}

return view.extend({
    serviceEnabled: false,
    lastRx: null,
    lastTx: null,
    lastTime: 0,

    updateRunning: false,
    updatePending: false,
    actionBusy: false,
    panelBusy: false,

    engineVersion: '--',
    panelInfo: null,

    // [fix] nodes 不再定义在原型上，改为在 render() 中初始化为实例属性，
    //       避免同一 view 类多次实例化时所有实例共享同一个对象引用

    handleSave: function(ev) {
        return uci.save().catch(function(err) {
            ui.addNotification(
                null,
                E('p', _('Failed to save configuration: %s').format(err.message || err)),
                'error'
            );
            throw err;
        });
    },

    handleSaveApply: function(ev) {
        var self = this;

        if (self.actionBusy)
            return Promise.resolve();

        self.actionBusy = true;
        self.setActionButtonsDisabled(true);

        return uci.save()
            .then(function() {
                return uci.apply();
            })
            .then(function() {
                // [fix] 将 enabled 的读取移至 uci.save() 完成之后，
                //       确保拿到的是用户已提交的最新值，而非调用前的旧值
                var enabled = uci.get('honk', 'config', 'enabled') === '1';
                self.serviceEnabled = enabled;
                return self.execService(enabled ? 'enable' : 'disable');
            })
            .then(function() {
                return self.updateDashboard();
            })
            .catch(function(err) {
                ui.addNotification(
                    null,
                    E('p', _('Failed to save/apply configuration: %s').format(err.message || err)),
                    'error'
                );
                throw err;
            })
            .finally(function() {
                self.actionBusy = false;
                self.setActionButtonsDisabled(false);
            });
    },

    handleReset: function(ev) {
        // [fix] uci.unload 返回 Promise，需等待其完成后再 reload，
        //       避免异步清理未结束时页面就已刷新导致脏数据残留
        return uci.unload('honk').then(function() {
            window.location.reload();
        });
    },

    load: function() {
        var self = this;
        return Promise.all([
            uci.load('honk'),
            L.resolveDefault(callServiceList('honk'), {}),
            L.resolveDefault(fs.exec('/usr/bin/honk-core', ['--version']), null)
        ]).then(function(results) {
            self.engineVersion = parseVersion(results[2]);
            return results;
        });
    },

    formatBytes: function(bytes) {
        // [fix] 将 bytes < 0（异常值）与 bytes === 0（合法零值）拆分判断，语义更清晰
        if (!isFinite(bytes) || bytes < 0)
            return '0 B';
        if (bytes === 0)
            return '0 B';

        var sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        i = Math.max(0, Math.min(i, sizes.length - 1));

        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    },

    //       - 速率：客户端对服务端计数器做差分（含计数器回落重基线）
    //       - 总量：直接显示服务端 rx/tx_bytes，语义为"自服务启动以来"
    //       - 删除 localStorage 客户端累加及每轮询周期的同步写
    updateTrafficStats: function(traffic) {
        var self = this;

        // Counter reset (service restart): re-baseline, skip this sample.
        if (self.lastRx === null || self.lastTx === null || !self.lastTime ||
            traffic.rx < self.lastRx || traffic.tx < self.lastTx) {
            self.lastRx = traffic.rx;
            self.lastTx = traffic.tx;
            self.lastTime = Date.now();
            return { rxRate: 0, txRate: 0, rx: traffic.rx, tx: traffic.tx };
        }

        var now = Date.now();
        var diff = (now - self.lastTime) / 1000;
        var rxRate = diff > 0 ? Math.max(0, traffic.rx - self.lastRx) / diff : 0;
        var txRate = diff > 0 ? Math.max(0, traffic.tx - self.lastTx) / diff : 0;

        self.lastRx = traffic.rx;
        self.lastTx = traffic.tx;
        self.lastTime = now;

        return { rxRate: rxRate, txRate: txRate, rx: traffic.rx, tx: traffic.tx };
    },

    getMemoryUsage: function(pid) {
        if (!pid)
            return Promise.resolve('--');

        return L.resolveDefault(fs.read_direct('/proc/' + pid + '/status', 'text'), '')
            .then(function(status) {
                var match = (status || '').match(/VmRSS:\s+(\d+)\s+kB/);
                if (!match)
                    return '--';

                var kb = parseInt(match[1], 10);
                return (isNaN(kb) || kb < 0) ? '--' : (kb / 1024).toFixed(1) + ' MB';
            });
    },

    getUptime: function(pid) {
        if (!pid)
            return Promise.resolve('--');

        return Promise.all([
            L.resolveDefault(fs.read_direct('/proc/uptime', 'text'), ''),
            L.resolveDefault(fs.read_direct('/proc/' + pid + '/stat', 'text'), '')
        ]).then(function(results) {
            var systemUptime = parseFloat((results[0] || '').trim().split(/\s+/)[0]);
            if (isNaN(systemUptime) || systemUptime < 0)
                return '--';

            var stat = (results[1] || '').trim();

            // [note] 使用 lastIndexOf(')') 处理进程名本身含括号的情况
            var closeParen = stat.lastIndexOf(')');
            if (closeParen < 0)
                return '--';

            // [note] closeParen+1 之后的字段布局（均以空格分隔）：
            //   index 19 → starttime（自系统启动后的 jiffies 数）
            // [note] OpenWrt 内核 CONFIG_HZ 几乎全部为 100。
            var CLK_TCK = 100;
            var parts = stat.substring(closeParen + 1).trim().split(/\s+/);
            if (parts.length < 20)
                return '--';

            var startTime = parseFloat(parts[19]);
            if (isNaN(startTime) || startTime < 0)
                return '--';

            var uptime = systemUptime - (startTime / CLK_TCK);
            if (isNaN(uptime) || uptime < 0)
                return '--';

            var hours = Math.floor(uptime / 3600);
            var minutes = Math.floor((uptime % 3600) / 60);
            var seconds = Math.floor(uptime % 60);

            if (hours)
                return hours + 'h ' + minutes + 'm ' + seconds + 's';
            if (minutes)
                return minutes + 'm ' + seconds + 's';

            return seconds + 's';
        });
    },

    getTrafficStats: function() {
        return L.resolveDefault(callHonkStats(), null).then(function(res) {
            if (!res || typeof res.tx_bytes === 'undefined' || typeof res.rx_bytes === 'undefined')
                return null;

            var rx = parseInt(res.rx_bytes, 10);
            var tx = parseInt(res.tx_bytes, 10);

            return (isNaN(rx) || isNaN(tx) || rx < 0 || tx < 0) ? null : { rx: rx, tx: tx };
        });
    },

    execService: function(action) {
        return fs.exec('/etc/init.d/honk', [action]).then(function(res) {
            if (res && typeof res.code !== 'undefined' && res.code !== 0) {
                throw new Error((res.stderr || res.stdout || action + ' failed').trim());
            }
            return res;
        });
    },

    setActionButtonsDisabled: function(disabled) {
        var buttons = document.querySelectorAll('.honk-actions button, #honk_autostart');
        for (var i = 0; i < buttons.length; i++)
            buttons[i].disabled = disabled;
    },

    setAutostart: function(enabled) {
        var self = this;

        if (self.actionBusy)
            return Promise.resolve();

        self.serviceEnabled = enabled;
        uci.set('honk', 'config', 'enabled', enabled ? '1' : '0');

        if (self.nodes.autostart) {
            self.nodes.autostart.className = 'honk-switch' + (enabled ? ' on' : '');
            self.nodes.autostart.disabled = false;
        }

        return Promise.resolve();
    },

    handleAction: function(action) {
        var self = this;
        if (self.actionBusy)
            return Promise.resolve();

        self.actionBusy = true;
        self.setActionButtonsDisabled(true);

        return self.execService(action)
            .then(function() {
                // [fix] init.d 脚本执行完毕后服务进程本身可能仍在启动中，
                //       加入短暂延迟再刷新状态，避免立即读到 running: false
                return new Promise(function(resolve) { setTimeout(resolve, 800); });
            })
            .then(function() {
                self.lastRx = null;
                self.lastTx = null;
                self.lastTime = 0;
                return self.updateDashboard();
            })
            .catch(function(err) {
                var link = E('a', { href: L.url('admin/services/honk/log') }, _('View Log'));
                ui.addNotification(null, E('p', {}, [
                    _('Service action failed: %s').format(err.message || err), ' ', link
                ]), 'error');
                throw err;
            })
            .finally(function() {
                self.actionBusy = false;
                self.setActionButtonsDisabled(false);
            });
    },

    /* ------------------------- web panel card ------------------------- */

    getPanelType: function() {
        var type = uci.get('honk', 'config', 'dashboard');
        return (type === 'none' || dash.profiles[type]) ? (type || 'none') : 'none';
    },

    renderPanelState: function() {
        var self = this;
        var n = self.nodes;
        var info = self.panelInfo || {};
        var type = self.getPanelType();

        if (type === 'none') {
            dom.content(n.panelState, [
                E('span', { 'class': 'honk-panel-state-idle' }, _('Panel disabled'))
            ]);
            if (n.panelOpen) n.panelOpen.disabled = true;
            if (n.panelDl) n.panelDl.disabled = true;
            return;
        }

        var profile = dash.getProfile(type);
        var parts = [ E('strong', {}, profile.label()) ];

        if (!info.has_ui) {
            parts.push(' ', E('span', { 'class': 'honk-panel-state-warn' }, _('not installed')));
        }
        else {
            parts.push(' ', E('span', { 'class': 'honk-panel-state-ok' }, _('installed')));
            if (info.external_ui)
                parts.push(E('div', { 'class': 'honk-panel-path' }, info.external_ui));
        }

        dom.content(n.panelState, parts);

        if (n.panelOpen) {
            n.panelOpen.disabled = !info.has_ui || self.panelBusy;
            n.panelOpen._honkUrl = (info.has_ui && info.host !== undefined)
                ? dash.buildUrl(type, info, true) : null;
        }
        if (n.panelDl) {
            n.panelDl.disabled = self.panelBusy;
            dom.content(n.panelDl, info.has_ui ? _('Update panel') : _('Download & install'));
        }
    },

    loadPanelInfo: function() {
        var self = this;
        var type = self.getPanelType();

        return L.resolveDefault(callPanelInfo(type), {}).then(function(info) {
            self.panelInfo = info || {};
            self.renderPanelState();
            return self.panelInfo;
        }, function(err) {
            dom.content(self.nodes.panelState, [
                E('span', { 'class': 'honk-panel-state-warn' }, _('RPC unavailable'))
            ]);
            console.warn('[honk] panel info error:', err);
            return {};
        });
    },

    onPanelTypeChange: function(type) {
        var self = this;

        if (self.panelBusy)
            return Promise.resolve();

        self.panelBusy = true;
        self.renderPanelState();

        return L.resolveDefault(callPanelSwitch(type), {}).then(function(res) {
            if (!res.success) {
                ui.addNotification(null, E('p', {},
                    _('Failed to switch panel: %s').format(res.message || '?')), 'error');
                return;
            }

            if (res.pending_download) {
                ui.addNotification(null, E('p', {},
                    _('Saved, but the panel files are not installed yet — download the panel first.')),
                    'warning');
            }
        }).catch(function(err) {
            ui.addNotification(null, E('p', {},
                _('Failed to switch panel: %s').format(err.message || err)), 'error');
        }).then(function() {
            self.panelBusy = false;
            return self.loadPanelInfo();
        });
    },

    stopPanelWatch: function() {
        if (this._panelWatch) {
            clearInterval(this._panelWatch);
            this._panelWatch = null;
        }
    },

    watchPanelDownload: function(type) {
        var self = this;
        var tries = 0;

        self.stopPanelWatch();

        self._panelWatch = setInterval(function() {
            tries++;

            if (tries > 150) {
                self.stopPanelWatch();
                self.panelBusy = false;
                self.renderPanelState();
                ui.addNotification(null, E('p', {}, _('Download did not finish in time.')), 'warning');
                return;
            }

            L.resolveDefault(callPanelDownloadStatus(), {}).then(function(st) {
                var status = (st && st.status) || 'IDLE';

                if (status === 'IDLE' || status === 'DOWNLOADING' ||
                    status === 'EXTRACTING' || status === '') {
                    dom.content(self.nodes.panelState, [
                        E('strong', {}, dash.getProfile(type).label()), ' ',
                        E('span', { 'class': 'honk-panel-state-warn' },
                            status === 'EXTRACTING' ? _('extracting...') : _('downloading...'))
                    ]);
                    return;
                }

                self.stopPanelWatch();
                self.panelBusy = false;

                if (status === 'SUCCESS') {
                    ui.addNotification(null, E('p', {}, _('Installation completed successfully!')), 'info');
                    return L.resolveDefault(callPanelSwitch(type), {})
                        .then(function() { return self.loadPanelInfo(); });
                }

                ui.addNotification(null, E('p', {}, _('Installation failed. Please check logs.')), 'error');
                self.renderPanelState();
            });
        }, 2000);
    },

    handlePanelDownload: function() {
        var self = this;
        var type = self.getPanelType();

        if (type === 'none' || self.panelBusy)
            return Promise.resolve();

        var profile = dash.getProfile(type);

        self.panelBusy = true;
        self.renderPanelState();

        return L.resolveDefault(callPanelDownload(profile.githubRelease, type), {}).then(function(res) {
            if (!res.success) {
                self.panelBusy = false;
                self.renderPanelState();
                ui.addNotification(null, E('p', {},
                    _('Download error:') + ' ' + (res.message || '?')), 'error');
                return;
            }

            self.watchPanelDownload(type);
        }).catch(function(err) {
            self.panelBusy = false;
            self.renderPanelState();
            ui.addNotification(null, E('p', {},
                _('Download error:') + ' ' + (err.message || err)), 'error');
        });
    },

    handlePanelOpen: function() {
        var n = this.nodes;
        if (!n.panelOpen || !n.panelOpen._honkUrl)
            return;
        window.open(n.panelOpen._honkUrl, '_blank', 'noopener');
    },

    updateDashboard: function() {
        var self = this;

        if (self.updateRunning) {
            self.updatePending = true;
            return Promise.resolve();
        }

        self.updateRunning = true;
        self.updatePending = false;

        return L.resolveDefault(callServiceList('honk'), {})
            .then(function(serviceData) {
                var instance = getInstanceInfo(serviceData);
                self.serviceEnabled = uci.get('honk', 'config', 'enabled') === '1';

                var trafficPromise = instance.running
                    ? self.getTrafficStats()
                    : Promise.resolve(null);

                return Promise.all([Promise.resolve(instance), trafficPromise]);
            })
            .then(function(results) {
                var instance = results[0];
                var traffic = results[1];

                return Promise.all([
                    self.getMemoryUsage(instance.pid),
                    self.getUptime(instance.pid)
                ]).then(function(metrics) {
                    var n = self.nodes;

                    if (n.badge) {
                        dom.content(n.badge, [
                            E('span', { 'class': 'honk-dot' }),
                            instance.running ? _('RUNNING') : _('NOT RUNNING')
                        ]);
                        n.badge.style.background = instance.running ? '#173e2c' : '#4a2525';
                        n.badge.style.color = instance.running ? '#65d875' : '#ed6a63';
                    }

                    if (n.memory)
                        n.memory.textContent = instance.running ? metrics[0] : '--';
                    if (n.uptime)
                        n.uptime.textContent = instance.running ? metrics[1] : '--';
                    if (n.version)
                        n.version.textContent = self.engineVersion;

                    if (n.autostart) {
                        n.autostart.className = 'honk-switch' + (self.serviceEnabled ? ' on' : '');
                        n.autostart.disabled = self.actionBusy;
                    }

                    if (!instance.running) {
                        self.lastRx = null;
                        self.lastTx = null;
                        self.lastTime = 0;

                        if (n.rate)
                            n.rate.textContent = '0 B/s ↑ / 0 B/s ↓';
                        if (n.total)
                            n.total.textContent = '-- / --';
                        return;
                    }

                    if (!traffic) {
                        if (n.rate)
                            n.rate.textContent = '-- / --';
                        if (n.total)
                            n.total.textContent = '-- / --';
                        return;
                    }

                    var trafficView = self.updateTrafficStats(traffic);

                    if (n.rate)
                        n.rate.textContent =
                            self.formatBytes(trafficView.txRate) + '/s ↑ / ' +
                            self.formatBytes(trafficView.rxRate) + '/s ↓';

                    if (n.total)
                        n.total.textContent =
                            self.formatBytes(trafficView.tx) + ' ↑ / ' +
                            self.formatBytes(trafficView.rx) + ' ↓';
                });
            })
            .then(function(result) {
                self.updateRunning = false;

                if (self.updatePending) {
                    self.updatePending = false;
                    return self.updateDashboard().then(function() {
                        return result;
                    });
                }

                return result;
            }, function(err) {
                self.updateRunning = false;
                return Promise.reject(err);
            });
    },

    // [fix] 实现 LuCI view 标准生命周期钩子 destroy()，
    //       在视图卸载时主动移除 poll 与下载轮询，
    //       替代原来在 poll 内部依赖 DOM 查询自检的脆弱方式
    destroy: function() {
        if (this._pollHandle) {
            poll.remove(this._pollHandle);
            this._pollHandle = null;
        }

        this.stopPanelWatch();
    },

    render: function() {
        var self = this;

        // [fix] 在 render() 中将 nodes 初始化为实例自身属性，
        //       避免原型链上的对象被多个实例共享
        self.nodes = {};

        self.serviceEnabled = uci.get('honk', 'config', 'enabled') === '1';

        self.nodes.badge = E('span', { 'class': 'honk-badge' }, [
            E('span', { 'class': 'honk-dot' }),
            _('Collecting data...')
        ]);

        self.nodes.memory = E('div', { 'class': 'honk-value' }, '--');
        self.nodes.uptime = E('div', { 'class': 'honk-value' }, '--');
        self.nodes.version = E('div', { 'class': 'honk-value' }, self.engineVersion);
        self.nodes.rate = E('div', { 'class': 'honk-subvalue' }, '0 B/s ↑ / 0 B/s ↓');
        self.nodes.total = E('div', { 'class': 'honk-subvalue' }, '0 B ↑ / 0 B ↓');

        self.nodes.autostart = E('button', {
            'id': 'honk_autostart',
            'class': 'honk-switch' + (self.serviceEnabled ? ' on' : ''),
            'type': 'button',
            'click': function() {
                if (!self.actionBusy)
                    self.setAutostart(!self.serviceEnabled).catch(function() {});
            }
        });

        /* ---- web panel card nodes ---- */

        var panelType = self.getPanelType();

        var panelOptions = [ E('option', { 'value': 'none' }, _('None')) ];
        Object.keys(dash.profiles).forEach(function(k) {
            panelOptions.push(E('option', { 'value': k }, dash.profiles[k].label()));
        });

        self.nodes.panelSelect = E('select', {
            'class': 'cbi-input-select honk-select',
            'change': function(ev) {
                self.onPanelTypeChange(ev.target.value).catch(function() {});
            }
        }, panelOptions);

        self.nodes.panelSelect.value = panelType;

        self.nodes.panelState = E('div', { 'class': 'honk-panel-state' }, '--');

        self.nodes.panelDl = E('button', {
            'class': 'btn cbi-button cbi-button-apply',
            'type': 'button',
            'click': function() {
                self.handlePanelDownload().catch(function() {});
            }
        }, _('Download & install'));

        self.nodes.panelOpen = E('button', {
            'class': 'btn cbi-button cbi-button-action',
            'type': 'button',
            'click': function() {
                self.handlePanelOpen();
            }
        }, _('Open panel'));

        self.nodes.panelOpen.disabled = true;

        // [note] CSS 理想情况下应提取为独立 .css 文件通过 LuCI 机制加载，
        //        此处保持内联以维持单文件结构，但提取为具名常量以提升可读性
        var CSS_RULES = [
            '.honk-dashboard{margin:0;padding:8px 0 24px}',
            '.honk-dashboard *{box-sizing:border-box}',
            '.honk-header{display:flex;align-items:center;gap:12px;margin-bottom:6px}',
            '.honk-dashboard h1{margin:0;font-size:28px;line-height:1.1;color:#f59e0b}',
            '.honk-description{margin:0 0 26px;color:var(--text-color-secondary,#666);font-size:14px;overflow-wrap:anywhere}',
            '.honk-badge{display:inline-flex;align-items:center;min-width:0;max-width:100%;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;overflow:hidden;overflow-wrap:anywhere}',
            '.honk-dot{display:inline-block;flex:0 0 auto;width:8px;height:8px;margin-right:8px;border-radius:50%;background:currentColor}',
            /* row 1: three equal-height statistic cards */
            '.honk-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:1fr;gap:16px;margin-bottom:18px;align-items:stretch}',
            '.honk-cards>.honk-card{display:flex;flex-direction:column;height:100%}',
            /* row 2: 服务 + 代理流量统计 + 面板, equal height with each other */
            '.honk-bottom-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:1fr;gap:16px;margin-top:22px;align-items:stretch}',
            '.honk-bottom-row>.honk-section{display:flex;flex-direction:column;height:100%}',
            '.honk-bottom-row>.honk-section>.honk-actions{margin-top:auto}',
            '.honk-card{min-width:0;max-width:100%;overflow:hidden;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)}',
            '.honk-label{min-width:0;color:var(--text-color-secondary,#666);font-size:13px;font-weight:700;overflow-wrap:anywhere;word-break:break-word}',
            '.honk-value{min-width:0;max-width:100%;margin-top:auto;padding-top:12px;font-size:24px;font-weight:800;color:#20a965;overflow-wrap:anywhere;word-break:break-word}',
            '.honk-card.version .honk-value{color:inherit;font-size:18px}',
            '.honk-section{min-width:0;max-width:100%;overflow:hidden;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)}',
            '.honk-section h2{margin:0 0 16px;font-size:18px;line-height:1.3;overflow-wrap:anywhere;word-break:break-word}',
            '.honk-service{display:flex;align-items:center;gap:14px;min-width:0;margin-bottom:18px}',
            '.honk-service span{min-width:0;overflow-wrap:anywhere;word-break:break-word}',
            '.honk-switch{position:relative;flex:0 0 auto;width:64px;height:34px;padding:0;border:0;border-radius:999px;background:#777;cursor:pointer}',
            '.honk-switch.on{background:#20bd68}',
            '.honk-switch:after{content:"";position:absolute;top:4px;left:4px;width:26px;height:26px;border-radius:50%;background:#fff;transition:left .18s ease}',
            '.honk-switch.on:after{left:34px}',
            '.honk-switch-small{width:54px;height:30px}',
            '.honk-switch-small:after{top:3px;left:3px;width:24px;height:24px}',
            '.honk-switch-small.on:after{left:27px}',
            '.honk-switch:disabled,.honk-actions .btn:disabled{opacity:.55;cursor:wait}',
            '.honk-actions{display:flex;flex-wrap:wrap;gap:10px}',
            '.honk-traffic-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}',
            '.honk-traffic-item{min-width:0;overflow:hidden}',
            '.honk-subvalue{min-width:0;max-width:100%;margin-top:8px;font-size:16px;font-weight:700;color:var(--text-color-primary,#333);overflow-wrap:anywhere;word-break:break-word}',
            /* panel card */
            '.honk-panel-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;min-width:0;margin-bottom:14px}',
            '.honk-panel-row .honk-label{flex:1 1 100%}',
            '.honk-select{flex:1 1 auto;min-width:0;width:100%;max-width:100%;padding:6px 8px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:6px;background:var(--background-color-primary,#fff);color:var(--text-color-primary,#333)}',
            '.honk-panel-state{min-width:0;font-size:13px;line-height:1.5;color:var(--text-color-secondary,#666);overflow-wrap:anywhere;word-break:break-word}',
            '.honk-panel-state strong{color:var(--text-color-primary,#333);font-size:14px}',
            '.honk-panel-state-ok{color:#20a965;font-weight:700}',
            '.honk-panel-state-warn{color:#d98026;font-weight:700}',
            '.honk-panel-state-idle{color:var(--text-color-secondary,#666)}',
            '.honk-panel-path{margin-top:4px;font-family:var(--font-mono,monospace);font-size:12px;opacity:.85}',
            '@media(max-width:1000px){.honk-bottom-row{grid-template-columns:repeat(2,minmax(0,1fr))}.honk-bottom-row>.honk-section:last-child{grid-column:1/-1}}',
            '@media(max-width:760px){.honk-cards{grid-template-columns:minmax(0,1fr)}.honk-bottom-row{grid-template-columns:minmax(0,1fr)}.honk-bottom-row>.honk-section:last-child{grid-column:auto}.honk-traffic-grid{grid-template-columns:minmax(0,1fr)}}'
        ].join('');

        var css = E('style', {}, CSS_RULES);

        var viewEl = E('div', { 'class': 'honk-dashboard' }, [
            E('div', { 'class': 'honk-header' }, [
                E('h1', {}, 'HONK'),
                self.nodes.badge
            ]),

            E('p', { 'class': 'honk-description' }, _('eBPF-based Linux high-performance transparent proxy solution (HONK engine).')),

            E('section', { 'class': 'honk-cards' }, [
                E('div', { 'class': 'honk-card' }, [
                    E('div', { 'class': 'honk-label' }, _('Memory Usage')),
                    self.nodes.memory
                ]),
                E('div', { 'class': 'honk-card' }, [
                    E('div', { 'class': 'honk-label' }, _('Uptime')),
                    self.nodes.uptime
                ]),
                E('div', { 'class': 'honk-card version' }, [
                    E('div', { 'class': 'honk-label' }, _('Engine Version')),
                    self.nodes.version
                ])
            ]),

            E('div', { 'class': 'honk-bottom-row' }, [
                E('section', { 'class': 'honk-section' }, [
                    E('h2', {}, _('Service')),

                    E('div', { 'class': 'honk-service' }, [
                        self.nodes.autostart,
                        E('span', {}, _('Autostart'))
                    ]),

                    E('div', { 'class': 'honk-actions' }, [
                        E('button', {
                            'class': 'btn cbi-button cbi-button-positive',
                            'type': 'button',
                            'click': function() {
                                if (!self.actionBusy)
                                    self.handleAction('start').catch(function() {});
                            }
                        }, _('Start')),

                        E('button', {
                            'class': 'btn cbi-button cbi-button-apply',
                            'type': 'button',
                            'click': function() {
                                if (!self.actionBusy)
                                    self.handleAction('restart').catch(function() {});
                            }
                        }, _('Restart')),

                        E('button', {
                            'class': 'btn cbi-button cbi-button-negative',
                            'type': 'button',
                            'click': function() {
                                if (!self.actionBusy)
                                    self.handleAction('stop').catch(function() {});
                            }
                        }, _('Stop'))
                    ])
                ]),

                E('section', { 'class': 'honk-section' }, [
                    E('h2', {}, _('Proxy Traffic Stats')),

                    E('div', { 'class': 'honk-traffic-grid' }, [
                        E('div', { 'class': 'honk-traffic-item' }, [
                            E('div', { 'class': 'honk-label' }, _('Real-time Rate (TX/RX)')),
                            self.nodes.rate
                        ]),
                        E('div', { 'class': 'honk-traffic-item' }, [
                            E('div', { 'class': 'honk-label' }, _('Total Traffic (since service start)')),
                            self.nodes.total
                        ])
                    ])
                ]),

                E('section', { 'class': 'honk-section honk-panel' }, [
                    E('h2', {}, _('Web Panel')),

                    E('div', { 'class': 'honk-panel-row' }, [
                        E('span', { 'class': 'honk-label' }, _('Panel Type')),
                        self.nodes.panelSelect
                    ]),

                    self.nodes.panelState,

                    E('div', { 'class': 'honk-actions' }, [
                        self.nodes.panelDl,
                        self.nodes.panelOpen
                    ])
                ])
            ])
        ]);

        // [fix] 移除无实际意义的 firstUpdate flag，
        //       改为直接在 catch 中展示通知，行为完全等价且更简洁
        self.updateDashboard().catch(function(err) {
            ui.addNotification(
                null,
                E('p', _('Failed to load dashboard data: %s').format(err.message || err)),
                'error'
            );
        });

        self.loadPanelInfo().catch(function() {});

        // [fix] poll 不再在内部通过 DOM 查询自检来决定是否停止，
        //       生命周期清理统一交由 destroy() 钩子负责
        self._pollHandle = poll.add(function() {
            return self.updateDashboard().catch(function() {});
        }, L.env.pollinterval);

        return E('div', { 'id': 'honk_dashboard' }, [css, viewEl]);
    }
});
