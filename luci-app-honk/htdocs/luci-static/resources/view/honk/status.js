// SPDX-License-Identifier: Apache-2.0

'use strict';

'require dom';
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
        var instances = serviceData && serviceData.honk && serviceData.honk.instances;
        if (!instances) return { running: false, pid: null };

        var key = instances.honk ? 'honk' : Object.keys(instances)[0];
        var instance = key ? instances[key] : null;

        return {
            running: !!(instance && instance.running),
            pid: instance && instance.pid ? instance.pid : null
        };
    } catch (e) {
        return { running: false, pid: null };
    }
}

function parseVersion(execResult) {
    var text = typeof execResult === 'string' ? execResult :
        (execResult && typeof execResult.stdout === 'string' ? execResult.stdout : '');

    text = text.trim();
    if (!text) return '--';

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

    subscriptionBusy: false,
    subscribeAutoUpdate: false,
    subscribeUpdateWeekTime: '*',
    subscribeUpdateDayTime: '0',

    engineVersion: '--',
    nodes: {},

    load: function () {
        var self = this;
        return Promise.all([
            uci.load('honk'),
            L.resolveDefault(callServiceList('honk'), {}),
            L.resolveDefault(fs.exec('/usr/bin/honk-core', ['--version']), null)
        ]).then(function (results) {
            self.engineVersion = parseVersion(results[2]);
            self.subscribeAutoUpdate = uci.get('honk', 'config', 'subscribe_auto_update') === '1';
            self.subscribeUpdateWeekTime = uci.get('honk', 'config', 'subscribe_update_week_time') || '*';
            self.subscribeUpdateDayTime = uci.get('honk', 'config', 'subscribe_update_day_time') || '0';
            return results;
        });
    },

    formatBytes: function (bytes) {
        if (!isFinite(bytes) || bytes <= 0) return '0 B';
        var sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        i = Math.max(0, Math.min(i, sizes.length - 1));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    },

    getMemoryUsage: function (pid) {
        if (!pid) return Promise.resolve('--');
        return L.resolveDefault(fs.read_direct('/proc/' + pid + '/status', 'text'), '')
            .then(function (status) {
                var match = (status || '').match(/VmRSS:\s+(\d+)\s+kB/);
                if (!match) return '--';
                var kb = parseInt(match[1], 10);
                return (isNaN(kb) || kb < 0) ? '--' : (kb / 1024).toFixed(1) + ' MB';
            });
    },

    getUptime: function (pid) {
        if (!pid) return Promise.resolve('--');
        return Promise.all([
            L.resolveDefault(fs.read_direct('/proc/uptime', 'text'), ''),
            L.resolveDefault(fs.read_direct('/proc/' + pid + '/stat', 'text'), '')
        ]).then(function (results) {
            var systemUptime = parseFloat((results[0] || '').trim().split(/\s+/)[0]);
            if (isNaN(systemUptime) || systemUptime < 0) return '--';

            var stat = (results[1] || '').trim();
            var closeParen = stat.lastIndexOf(')');
            if (closeParen < 0) return '--';

            var parts = stat.substring(closeParen + 1).trim().split(/\s+/);
            if (parts.length < 20) return '--';

            var startTime = parseFloat(parts[19]);
            if (isNaN(startTime) || startTime < 0) return '--';

            var uptime = systemUptime - (startTime / 100);
            if (isNaN(uptime) || uptime < 0) return '--';

            var hours = Math.floor(uptime / 3600);
            var minutes = Math.floor((uptime % 3600) / 60);
            var seconds = Math.floor(uptime % 60);

            if (hours) return hours + 'h ' + minutes + 'm ' + seconds + 's';
            if (minutes) return minutes + 'm ' + seconds + 's';
            return seconds + 's';
        });
    },

    getTrafficStats: function () {
        return L.resolveDefault(callHonkStats(), null).then(function (res) {
            if (!res || typeof res.tx_bytes === 'undefined' || typeof res.rx_bytes === 'undefined') return null;

            var rx = parseInt(res.rx_bytes, 10);
            var tx = parseInt(res.tx_bytes, 10);

            return (isNaN(rx) || isNaN(tx) || rx < 0 || tx < 0) ? null : { rx: rx, tx: tx };
        });
    },

    execService: function (action) {
        return fs.exec('/etc/init.d/honk', [action]).then(function (res) {
            if (res && typeof res.code !== 'undefined' && res.code !== 0) {
                throw new Error((res.stderr || res.stdout || action + ' failed').trim());
            }
            return res;
        });
    },

    setActionButtonsDisabled: function (disabled) {
        var buttons = document.querySelectorAll('.honk-actions button, #honk_autostart');
        for (var i = 0; i < buttons.length; i++) buttons[i].disabled = disabled;
    },

    updateSubscriptionControls: function () {
        var self = this;
        var disabled = self.subscriptionBusy || !self.subscribeAutoUpdate;

        if (self.nodes.subscribeWeek) self.nodes.subscribeWeek.disabled = disabled;
        if (self.nodes.subscribeDay) self.nodes.subscribeDay.disabled = disabled;
        if (self.nodes.subscribeAuto) self.nodes.subscribeAuto.disabled = self.subscriptionBusy;
        if (self.nodes.subscribeSave) self.nodes.subscribeSave.disabled = self.subscriptionBusy;
    },

    saveSubscriptionConfig: function () {
        var self = this;

        if (self.subscriptionBusy) return Promise.resolve();

        self.subscriptionBusy = true;
        self.updateSubscriptionControls();

        uci.set('honk', 'config', 'subscribe_auto_update', self.subscribeAutoUpdate ? '1' : '0');
        uci.set('honk', 'config', 'subscribe_update_week_time', self.subscribeUpdateWeekTime);
        uci.set('honk', 'config', 'subscribe_update_day_time', self.subscribeUpdateDayTime);

        return uci.save()
            .then(function () { return uci.apply(); })
            .then(function () {
                ui.addNotification(null, E('p', {}, _('Subscription settings saved.')), 'info');
            })
            .catch(function (err) {
                ui.addNotification(null, E('p', {}, [
                    _('Failed to save subscription settings: %s').format(err.message || err)
                ]), 'error');
                throw err;
            })
            .finally(function () {
                self.subscriptionBusy = false;
                self.updateSubscriptionControls();
            });
    },

    setAutostart: function (enabled) {
        var self = this;
        if (self.actionBusy) return Promise.resolve();

        self.actionBusy = true;
        self.setActionButtonsDisabled(true);

        uci.set('honk', 'config', 'enabled', enabled ? '1' : '0');

        return uci.save()
            .then(function () { return uci.apply(); })
            .then(function () { return self.execService(enabled ? 'enable' : 'disable'); })
            .then(function () {
                self.serviceEnabled = enabled;
                return self.updateDashboard();
            })
            .catch(function (err) {
                ui.addNotification(null, E('p', _('Failed to update autostart: %s').format(err.message || err)), 'error');
                throw err;
            })
            .finally(function () {
                self.actionBusy = false;
                self.setActionButtonsDisabled(false);
            });
    },

    handleAction: function (action) {
        var self = this;
        if (self.actionBusy) return Promise.resolve();

        self.actionBusy = true;
        self.setActionButtonsDisabled(true);

        return self.execService(action)
            .then(function () {
                self.lastRx = null;
                self.lastTx = null;
                self.lastTime = 0;
                return self.updateDashboard();
            })
            .catch(function (err) {
                var link = E('a', { href: L.url('admin/services/honk/log') }, _('View Log'));
                ui.addNotification(null, E('p', {}, [
                    _('Service action failed: %s').format(err.message || err), ' ', link
                ]), 'error');
                throw err;
            })
            .finally(function () {
                self.actionBusy = false;
                self.setActionButtonsDisabled(false);
            });
    },

    updateDashboard: function () {
        var self = this;

        if (self.updateRunning) {
            self.updatePending = true;
            return Promise.resolve();
        }

        self.updateRunning = true;
        self.updatePending = false;

        return Promise.all([
            L.resolveDefault(callServiceList('honk'), {}),
            self.getTrafficStats()
        ]).then(function (results) {
            var instance = getInstanceInfo(results[0]);
            var traffic = results[1];

            self.serviceEnabled = uci.get('honk', 'config', 'enabled') === '1';

            return Promise.all([
                self.getMemoryUsage(instance.pid),
                self.getUptime(instance.pid)
            ]).then(function (metrics) {
                var n = self.nodes;

                if (n.badge) {
                    dom.content(n.badge, [
                        E('span', { 'class': 'honk-dot' }),
                        instance.running ? _('RUNNING') : _('NOT RUNNING')
                    ]);
                    n.badge.style.background = instance.running ? '#173e2c' : '#4a2525';
                    n.badge.style.color = instance.running ? '#65d875' : '#ed6a63';
                }

                if (n.memory) n.memory.textContent = instance.running ? metrics[0] : '--';
                if (n.uptime) n.uptime.textContent = instance.running ? metrics[1] : '--';
                if (n.version) n.version.textContent = self.engineVersion;

                if (n.autostart) {
                    n.autostart.className = 'honk-switch' + (self.serviceEnabled ? ' on' : '');
                    n.autostart.disabled = self.actionBusy;
                }

                if (!instance.running) {
                    self.lastRx = null;
                    self.lastTx = null;
                    self.lastTime = 0;

                    if (n.rate) n.rate.textContent = '0 B/s ↑ / 0 B/s ↓';
                    return;
                }

                if (!traffic) {
                    if (n.rate) n.rate.textContent = '-- / --';
                    return;
                }

                var now = Date.now();

                if (self.lastRx === null || self.lastTx === null || !self.lastTime ||
                    traffic.rx < self.lastRx || traffic.tx < self.lastTx) {

                    self.lastRx = traffic.rx;
                    self.lastTx = traffic.tx;
                    self.lastTime = now;

                    if (n.rate) n.rate.textContent = '0 B/s ↑ / 0 B/s ↓';
                    if (n.total) n.total.textContent =
                        self.formatBytes(traffic.tx) + ' ↑ / ' +
                        self.formatBytes(traffic.rx) + ' ↓';

                    return;
                }

                var diff = (now - self.lastTime) / 1000;
                var rxRate = diff > 0 ? Math.max(0, (traffic.rx - self.lastRx) / diff) : 0;
                var txRate = diff > 0 ? Math.max(0, (traffic.tx - self.lastTx) / diff) : 0;

                self.lastRx = traffic.rx;
                self.lastTx = traffic.tx;
                self.lastTime = now;

                if (n.rate) n.rate.textContent =
                    self.formatBytes(txRate) + '/s ↑ / ' +
                    self.formatBytes(rxRate) + '/s ↓';

                if (n.total) n.total.textContent =
                    self.formatBytes(traffic.tx) + ' ↑ / ' +
                    self.formatBytes(traffic.rx) + ' ↓';
            });
        }).then(function (result) {
            self.updateRunning = false;

            if (self.updatePending) {
                self.updatePending = false;
                return self.updateDashboard().then(function () {
                    return result;
                });
            }

            return result;
        }, function (err) {
            self.updateRunning = false;
            return Promise.reject(err);
        });
    },

    render: function () {
        var self = this;

        self.serviceEnabled = uci.get('honk', 'config', 'enabled') === '1';
        self.subscribeAutoUpdate = uci.get('honk', 'config', 'subscribe_auto_update') === '1';
        self.subscribeUpdateWeekTime = uci.get('honk', 'config', 'subscribe_update_week_time') || '*';
        self.subscribeUpdateDayTime = uci.get('honk', 'config', 'subscribe_update_day_time') || '0';

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
            'click': function () {
                if (!self.actionBusy) self.setAutostart(!self.serviceEnabled).catch(function () {});
            }
        });

        self.nodes.subscribeAuto = E('button', {
            'id': 'honk_subscribe_auto_update',
            'class': 'honk-switch honk-switch-small' + (self.subscribeAutoUpdate ? ' on' : ''),
            'type': 'button',
            'click': function () {
                if (self.subscriptionBusy) return;

                self.subscribeAutoUpdate = !self.subscribeAutoUpdate;
                self.nodes.subscribeAuto.className =
                    'honk-switch honk-switch-small' +
                    (self.subscribeAutoUpdate ? ' on' : '');

                self.updateSubscriptionControls();
            }
        });

        self.nodes.subscribeWeek = E('select', {
            'id': 'honk_subscribe_update_week_time',
            'class': 'honk-select',
            'change': function (ev) {
                self.subscribeUpdateWeekTime = ev.target.value;
            }
        }, [
            E('option', { 'value': '*' }, _('Every Day')),
            E('option', { 'value': '1' }, _('Every Monday')),
            E('option', { 'value': '2' }, _('Every Tuesday')),
            E('option', { 'value': '3' }, _('Every Wednesday')),
            E('option', { 'value': '4' }, _('Every Thursday')),
            E('option', { 'value': '5' }, _('Every Friday')),
            E('option', { 'value': '6' }, _('Every Saturday')),
            E('option', { 'value': '7' }, _('Every Sunday'))
        ]);

        self.nodes.subscribeWeek.value = self.subscribeUpdateWeekTime;

        var timeOptions = [];
        for (var t = 0; t < 24; t++) {
            timeOptions.push(E('option', { 'value': String(t) }, t + ':00'));
        }

        self.nodes.subscribeDay = E('select', {
            'id': 'honk_subscribe_update_day_time',
            'class': 'honk-select',
            'change': function (ev) {
                self.subscribeUpdateDayTime = ev.target.value;
            }
        }, timeOptions);

        self.nodes.subscribeDay.value = self.subscribeUpdateDayTime;

        self.nodes.subscribeSave = E('button', {
            'class': 'btn cbi-button cbi-button-apply honk-subscribe-save',
            'type': 'button',
            'click': function () {
                self.saveSubscriptionConfig().catch(function () {});
            }
        }, _('Save & Apply'));

        var css = E('style', {}, '\
            .honk-dashboard{margin:0;padding:8px 0 24px}\
            .honk-dashboard *{box-sizing:border-box}\
            .honk-header{display:flex;align-items:center;gap:12px;margin-bottom:6px}\
            .honk-dashboard h1{margin:0;font-size:28px;line-height:1.1;color:#f59e0b}\
            .honk-description{margin:0 0 26px;color:var(--text-color-secondary,#666);font-size:14px;overflow-wrap:anywhere}\
            .honk-badge{display:inline-flex;align-items:center;min-width:0;max-width:100%;padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;overflow:hidden;overflow-wrap:anywhere}\
            .honk-dot{display:inline-block;flex:0 0 auto;width:8px;height:8px;margin-right:8px;border-radius:50%;background:currentColor}\
            .honk-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:18px}\
            .honk-card{min-width:0;max-width:100%;overflow:hidden;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)}\
            .honk-label{min-width:0;color:var(--text-color-secondary,#666);font-size:13px;font-weight:700;overflow-wrap:anywhere;word-break:break-word}\
            .honk-value{min-width:0;max-width:100%;margin-top:12px;font-size:24px;font-weight:800;color:#20a965;overflow-wrap:anywhere;word-break:break-word}\
            .honk-card.version .honk-value{color:inherit;font-size:18px}\
            .honk-bottom-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;margin-top:22px}\
            .honk-section{min-width:0;max-width:100%;overflow:hidden;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)}\
            .honk-section h2{margin:0 0 16px;font-size:18px;overflow-wrap:anywhere;word-break:break-word}\
            .honk-service{display:flex;align-items:center;gap:14px;min-width:0;margin-bottom:18px}\
            .honk-service span{min-width:0;overflow-wrap:anywhere;word-break:break-word}\
            .honk-switch{position:relative;flex:0 0 auto;width:64px;height:34px;padding:0;border:0;border-radius:999px;background:#777;cursor:pointer}\
            .honk-switch.on{background:#20bd68}\
            .honk-switch:after{content:"";position:absolute;top:4px;left:4px;width:26px;height:26px;border-radius:50%;background:#fff;transition:left .18s ease}\
            .honk-switch.on:after{left:34px}\
            .honk-switch-small{width:54px;height:30px}\
            .honk-switch-small:after{top:3px;left:3px;width:24px;height:24px}\
            .honk-switch-small.on:after{left:27px}\
            .honk-switch:disabled,.honk-actions .btn:disabled,.honk-subscribe-save:disabled{opacity:.55;cursor:wait}\
            .honk-actions{display:flex;flex-wrap:wrap;gap:10px}\
            .honk-subscription{min-width:0;margin-top:22px;padding-top:18px;border-top:1px solid var(--border-color-medium,#d9d9d9)}\
            .honk-subscription-title{margin:0 0 14px;font-size:16px;font-weight:800;overflow-wrap:anywhere}\
            .honk-subscription-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);align-items:center;gap:12px;min-width:0;margin-bottom:12px}\
            .honk-subscription-label{min-width:0;color:var(--text-color-secondary,#666);font-size:13px;font-weight:700;overflow-wrap:anywhere;word-break:break-word}\
            .honk-subscription-control{min-width:0;display:flex;align-items:center;justify-content:flex-end}\
            .honk-select{width:100%;min-width:0;max-width:100%;padding:7px 30px 7px 9px;border:1px solid var(--border-color-medium,#ccc);border-radius:6px;background:var(--background-color-primary,#fff);color:var(--text-color-primary,#333);font-size:13px;overflow:hidden;text-overflow:ellipsis}\
            .honk-select:disabled{opacity:.55;cursor:not-allowed}\
            .honk-subscribe-save-row{display:flex;justify-content:flex-end;min-width:0;margin-top:16px}\
            .honk-subscribe-save{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
            .honk-traffic-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}\
            .honk-traffic-item{min-width:0;overflow:hidden}\
            .honk-subvalue{min-width:0;max-width:100%;margin-top:8px;font-size:16px;font-weight:700;color:var(--text-color-primary,#333);overflow-wrap:anywhere;word-break:break-word}\
            @media(max-width:800px){.honk-bottom-row{grid-template-columns:minmax(0,1fr)}}\
            @media(max-width:640px){.honk-cards{grid-template-columns:minmax(0,1fr)}.honk-traffic-grid{grid-template-columns:minmax(0,1fr)}.honk-subscription-row{grid-template-columns:minmax(0,1fr);gap:6px}.honk-subscription-control{justify-content:flex-start}}');

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
                            'click': function () {
                                if (!self.actionBusy) self.handleAction('start').catch(function () {});
                            }
                        }, _('Start')),

                        E('button', {
                            'class': 'btn cbi-button cbi-button-apply',
                            'type': 'button',
                            'click': function () {
                                if (!self.actionBusy) self.handleAction('restart').catch(function () {});
                            }
                        }, _('Restart')),

                        E('button', {
                            'class': 'btn cbi-button cbi-button-negative',
                            'type': 'button',
                            'click': function () {
                                if (!self.actionBusy) self.handleAction('stop').catch(function () {});
                            }
                        }, _('Stop'))
                    ]),

                    E('div', { 'class': 'honk-subscription' }, [
                        E('h3', { 'class': 'honk-subscription-title' }, _('Subscription Update')),

                        E('div', { 'class': 'honk-subscription-row' }, [
                            E('div', { 'class': 'honk-subscription-label' }, _('Enable Auto Subscribe Update')),
                            E('div', { 'class': 'honk-subscription-control' }, [
                                self.nodes.subscribeAuto
                            ])
                        ]),

                        E('div', { 'class': 'honk-subscription-row' }, [
                            E('div', { 'class': 'honk-subscription-label' }, _('Update Cycle')),
                            E('div', { 'class': 'honk-subscription-control' }, [
                                self.nodes.subscribeWeek
                            ])
                        ]),

                        E('div', { 'class': 'honk-subscription-row' }, [
                            E('div', { 'class': 'honk-subscription-label' }, _('Update Time (Every Day)')),
                            E('div', { 'class': 'honk-subscription-control' }, [
                                self.nodes.subscribeDay
                            ])
                        ]),

                        E('div', { 'class': 'honk-subscribe-save-row' }, [
                            self.nodes.subscribeSave
                        ])
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
                            E('div', { 'class': 'honk-label' }, _('Total Traffic (TX/RX)')),
                            self.nodes.total
                        ])
                    ])
                ])
            ])
        ]);

        self.updateSubscriptionControls();

        self.updateDashboard().catch(function () {});
        poll.add(function () { return self.updateDashboard().catch(function () {}); }, 3);

        return E('div', {}, [css, viewEl]);
    }
});
