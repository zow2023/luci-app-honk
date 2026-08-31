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
        var service = serviceData && serviceData.honk;
        var instances = service && service.instances;

        if (!instances)
            return {
                running: false,
                pid: null
            };

        var instanceKey = instances.honk
            ? 'honk'
            : Object.keys(instances)[0];

        if (!instanceKey)
            return {
                running: false,
                pid: null
            };

        var instance = instances[instanceKey];

        return {
            running: !!(instance && instance.running),
            pid: instance && instance.pid
                ? instance.pid
                : null
        };
    } catch (e) {
        return {
            running: false,
            pid: null
        };
    }
}

function parseVersion(execResult) {
    var text = '';

    if (typeof execResult === 'string') {
        text = execResult;
    } else if (
        execResult &&
        typeof execResult.stdout === 'string'
    ) {
        text = execResult.stdout;
    }

    text = (text || '').trim();

    if (!text)
        return '--';

    var match =
        text.match(
            /honk(?:-core)?\s+v?([^\s]+)/i
        ) ||
        text.match(
            /version\s+v?([^\s]+)/i
        );

    if (match && match[1])
        return match[1];

    var firstLine = text
        .split(/\r?\n/)[0]
        .trim();

    return firstLine || '--';
}

return view.extend({
    serviceEnabled: false,

    /*
     * Traffic rate baseline.
     *
     * null means there is currently no valid baseline.
     */
    lastRx: null,
    lastTx: null,
    lastTime: 0,

    /*
     * Prevent overlapping dashboard updates.
     *
     * If a poll arrives while one update is running,
     * request another update after the current one finishes.
     */
    dashboardUpdating: false,
    dashboardRefreshPending: false,

    /*
     * Prevent duplicated service operations.
     */
    actionBusy: false,

    /*
     * Version is effectively static during this view lifetime.
     */
    engineVersion: '--',

    load: function () {
        var self = this;

        return Promise.all([
            uci.load('honk'),

            L.resolveDefault(
                callServiceList('honk'),
                {}
            ),

            L.resolveDefault(
                fs.exec(
                    '/usr/bin/honk-core',
                    ['--version']
                ),
                null
            )
        ]).then(function (results) {
            self.engineVersion =
                parseVersion(results[2]);

            return results;
        });
    },

    formatBytes: function (bytes) {
        if (
            typeof bytes !== 'number' ||
            !isFinite(bytes) ||
            bytes <= 0
        ) {
            return '0 B';
        }

        var k = 1024;
        var sizes = [
            'B',
            'KiB',
            'MiB',
            'GiB',
            'TiB'
        ];

        var i = Math.floor(
            Math.log(bytes) / Math.log(k)
        );

        if (i < 0)
            i = 0;

        if (i >= sizes.length)
            i = sizes.length - 1;

        return (
            bytes / Math.pow(k, i)
        ).toFixed(1) +
            ' ' +
            sizes[i];
    },

    getMemoryUsage: function (pid) {
        if (!pid)
            return Promise.resolve('--');

        /*
         * /proc/PID/status is a very small pseudo-file.
         *
         * read_direct() is appropriate here. This is NOT comparable
         * to reading a potentially huge log file.
         */
        return L.resolveDefault(
            fs.read_direct(
                '/proc/' + pid + '/status',
                'text'
            ),
            ''
        ).then(function (status) {
            var match = (status || '').match(
                /VmRSS:\s+(\d+)\s+kB/
            );

            if (!match)
                return '--';

            var kb = parseInt(
                match[1],
                10
            );

            if (
                isNaN(kb) ||
                kb < 0
            ) {
                return '--';
            }

            return (
                kb / 1024
            ).toFixed(1) + ' MB';
        });
    },

    getUptime: function (pid) {
        if (!pid)
            return Promise.resolve('--');

        return Promise.all([
            /*
             * These are tiny /proc files.
             */
            L.resolveDefault(
                fs.read_direct(
                    '/proc/uptime',
                    'text'
                ),
                ''
            ),

            L.resolveDefault(
                fs.read_direct(
                    '/proc/' + pid + '/stat',
                    'text'
                ),
                ''
            )
        ]).then(function (results) {
            var systemUptime = parseFloat(
                (results[0] || '')
                    .trim()
                    .split(/\s+/)[0]
            );

            if (
                isNaN(systemUptime) ||
                systemUptime < 0
            ) {
                return '--';
            }

            var stat = (
                results[1] || ''
            ).trim();

            if (!stat)
                return '--';

            /*
             * /proc/<pid>/stat:
             *
             *   pid (comm) state ...
             *
             * comm may contain spaces, so parsing with a simple
             * split() from the beginning is unsafe.
             */
            var closeParen =
                stat.lastIndexOf(')');

            if (closeParen === -1)
                return '--';

            /*
             * After "(comm)", the first remaining field is:
             *
             *   state = field 3
             *
             * starttime is field 22.
             *
             * Therefore starttime is index 19 in this array.
             */
            var statParts = stat
                .substring(closeParen + 1)
                .trim()
                .split(/\s+/);

            if (statParts.length < 20)
                return '--';

            var startTimeJiffies =
                parseFloat(statParts[19]);

            if (
                isNaN(startTimeJiffies) ||
                startTimeJiffies < 0
            ) {
                return '--';
            }

            /*
             * Keep the existing OpenWrt/Linux assumption.
             */
            var USER_HZ = 100;

            var processStartTime =
                startTimeJiffies / USER_HZ;

            var processUptime =
                systemUptime -
                processStartTime;

            if (
                isNaN(processUptime) ||
                processUptime < 0
            ) {
                return '--';
            }

            var hours = Math.floor(
                processUptime / 3600
            );

            var minutes = Math.floor(
                (processUptime % 3600) / 60
            );

            var seconds = Math.floor(
                processUptime % 60
            );

            if (hours > 0) {
                return (
                    hours +
                    'h ' +
                    minutes +
                    'm ' +
                    seconds +
                    's'
                );
            }

            if (minutes > 0) {
                return (
                    minutes +
                    'm ' +
                    seconds +
                    's'
                );
            }

            return seconds + 's';
        });
    },

    getTrafficStats: function () {
        /*
         * Keep the original, experimentally verified UBUS source.
         *
         * Do not reinterpret or replace getStats().
         */
        return L.resolveDefault(
            callHonkStats(),
            null
        ).then(function (res) {
            if (
                !res ||
                typeof res.tx_bytes === 'undefined' ||
                typeof res.rx_bytes === 'undefined'
            ) {
                return null;
            }

            var rx = parseInt(
                res.rx_bytes,
                10
            );

            var tx = parseInt(
                res.tx_bytes,
                10
            );

            if (
                isNaN(rx) ||
                isNaN(tx) ||
                rx < 0 ||
                tx < 0
            ) {
                return null;
            }

            return {
                rx: rx,
                tx: tx
            };
        });
    },

    execService: function (action) {
        return fs.exec(
            '/etc/init.d/honk',
            [action]
        ).then(function (res) {
            if (
                res &&
                typeof res.code !== 'undefined' &&
                res.code !== 0
            ) {
                var message =
                    res.stderr ||
                    res.stdout ||
                    (action + ' failed');

                throw new Error(
                    String(message).trim()
                );
            }

            return res;
        });
    },

    setAutostart: function (enabled) {
        var self = this;

        if (self.actionBusy)
            return Promise.resolve();

        self.actionBusy = true;

        uci.set(
            'honk',
            'config',
            'enabled',
            enabled ? '1' : '0'
        );

        return uci.save()
            .then(function () {
                return uci.apply();
            })
            .then(function () {
                return self.execService(
                    enabled
                        ? 'enable'
                        : 'disable'
                );
            })
            .then(function () {
                self.serviceEnabled =
                    enabled;

                return self.updateDashboard();
            })
            .catch(function (err) {
                ui.addNotification(
                    null,
                    E(
                        'p',
                        _(
                            'Failed to update autostart: %s'
                        ).format(
                            err.message || err
                        )
                    ),
                    'error'
                );

                throw err;
            })
            .then(
                function (result) {
                    self.actionBusy = false;
                    return result;
                },
                function (err) {
                    self.actionBusy = false;
                    throw err;
                }
            );
    },

    handleAction: function (action) {
        var self = this;

        if (self.actionBusy)
            return Promise.resolve();

        self.actionBusy = true;

        return self.execService(action)
            .then(function () {
                /*
                 * Reset traffic baseline immediately after a service
                 * operation. The next successful stats response will
                 * establish a fresh baseline.
                 */
                self.lastRx = null;
                self.lastTx = null;
                self.lastTime = 0;

                return self.updateDashboard();
            })
            .catch(function (err) {
                var link = E(
                    'a',
                    {
                        href: L.url(
                            'admin/services/honk/log'
                        )
                    },
                    _('View Log')
                );

                ui.addNotification(
                    null,
                    E(
                        'p',
                        {},
                        _(
                            'Service action failed: %s'
                        ).format(
                            err.message || err
                        ),
                        ' ',
                        link
                    ),
                    'error'
                );

                throw err;
            })
            .then(
                function (result) {
                    self.actionBusy = false;
                    return result;
                },
                function (err) {
                    self.actionBusy = false;
                    throw err;
                }
            );
    },

    updateDashboard: function () {
        var self = this;

        /*
         * If a refresh is already running, remember that another
         * refresh is needed instead of starting a concurrent one.
         */
        if (self.dashboardUpdating) {
            self.dashboardRefreshPending = true;
            return Promise.resolve();
        }

        self.dashboardUpdating = true;
        self.dashboardRefreshPending = false;

        return Promise.all([
            L.resolveDefault(
                callServiceList('honk'),
                {}
            ),

            self.getTrafficStats()
        ]).then(function (results) {
            var instanceInfo =
                getInstanceInfo(results[0]);

            var traffic =
                results[1];

            var version =
                self.engineVersion || '--';

            var autostart =
                uci.get(
                    'honk',
                    'config',
                    'enabled'
                ) === '1';

            self.serviceEnabled =
                autostart;

            return Promise.all([
                self.getMemoryUsage(
                    instanceInfo.pid
                ),
                self.getUptime(
                    instanceInfo.pid
                )
            ]).then(function (metrics) {
                var badge =
                    document.getElementById(
                        'honk_badge'
                    );

                var memory =
                    document.getElementById(
                        'honk_memory'
                    );

                var uptime =
                    document.getElementById(
                        'honk_uptime'
                    );

                var versionEl =
                    document.getElementById(
                        'honk_version'
                    );

                var autostartEl =
                    document.getElementById(
                        'honk_autostart'
                    );

                var rateEl =
                    document.getElementById(
                        'honk_traffic_rate'
                    );

                var totalEl =
                    document.getElementById(
                        'honk_traffic_total'
                    );

                /*
                 * The view may have been removed while asynchronous
                 * operations were in flight.
                 */
                if (!badge &&
                    !memory &&
                    !uptime &&
                    !versionEl &&
                    !autostartEl &&
                    !rateEl &&
                    !totalEl) {
                    return;
                }

                if (badge) {
                    /*
                     * Use DOM construction instead of innerHTML.
                     */
                    dom.content(
                        badge,
                        [
                            E(
                                'span',
                                {
                                    'class':
                                        'honk-dot'
                                }
                            ),
                            instanceInfo.running
                                ? _('RUNNING')
                                : _('NOT RUNNING')
                        ]
                    );

                    badge.style.background =
                        instanceInfo.running
                            ? '#173e2c'
                            : '#4a2525';

                    badge.style.color =
                        instanceInfo.running
                            ? '#65d875'
                            : '#ed6a63';
                }

                if (memory) {
                    memory.textContent =
                        instanceInfo.running
                            ? metrics[0]
                            : '--';
                }

                if (uptime) {
                    uptime.textContent =
                        instanceInfo.running
                            ? metrics[1]
                            : '--';
                }

                if (versionEl) {
                    versionEl.textContent =
                        version;
                }

                if (autostartEl) {
                    autostartEl.className =
                        'honk-switch' +
                        (
                            autostart
                                ? ' on'
                                : ''
                        );

                    autostartEl.disabled =
                        self.actionBusy;
                }

                /*
                 * If service is not running, invalidate the traffic
                 * baseline. This avoids calculating a rate across
                 * a stop/start boundary.
                 */
                if (!instanceInfo.running) {
                    self.lastRx = null;
                    self.lastTx = null;
                    self.lastTime = 0;

                    if (rateEl) {
                        rateEl.textContent =
                            '0 B/s ↑ / 0 B/s ↓';
                    }

                    if (totalEl) {
                        totalEl.textContent =
                            '0 B ↑ / 0 B ↓';
                    }

                    return;
                }

                /*
                 * Service is running but the stats RPC failed.
                 *
                 * Keep the last valid total and baseline.
                 * Do not convert the failure into fake zero traffic.
                 */
                if (!traffic) {
                    if (rateEl) {
                        rateEl.textContent =
                            '-- / --';
                    }

                    return;
                }

                var now = Date.now();

                var timeDiff =
                    self.lastTime > 0
                        ? (
                            now -
                            self.lastTime
                        ) / 1000
                        : 0;

                var rxRate = 0;
                var txRate = 0;

                if (
                    timeDiff > 0 &&
                    self.lastRx !== null &&
                    self.lastTx !== null
                ) {
                    /*
                     * Counters may reset after service restart.
                     * Prevent negative displayed rates.
                     */
                    rxRate = Math.max(
                        0,
                        (
                            traffic.rx -
                            self.lastRx
                        ) / timeDiff
                    );

                    txRate = Math.max(
                        0,
                        (
                            traffic.tx -
                            self.lastTx
                        ) / timeDiff
                    );
                }

                /*
                 * Update baseline only after successful stats retrieval.
                 */
                self.lastRx = traffic.rx;
                self.lastTx = traffic.tx;
                self.lastTime = now;

                if (rateEl) {
                    rateEl.textContent =
                        self.formatBytes(
                            txRate
                        ) +
                        '/s ↑ / ' +
                        self.formatBytes(
                            rxRate
                        ) +
                        '/s ↓';
                }

                if (totalEl) {
                    totalEl.textContent =
                        self.formatBytes(
                            traffic.tx
                        ) +
                        ' ↑ / ' +
                        self.formatBytes(
                            traffic.rx
                        ) +
                        ' ↓';
                }
            });
        }).then(
            function (result) {
                self.dashboardUpdating = false;

                /*
                 * A poll may have arrived while the previous refresh
                 * was running. Perform exactly one follow-up refresh.
                 */
                if (self.dashboardRefreshPending) {
                    self.dashboardRefreshPending = false;

                    return self.updateDashboard()
                        .then(function () {
                            return result;
                        });
                }

                return result;
            },
            function (err) {
                self.dashboardUpdating = false;

                /*
                 * Do not leave a pending refresh stuck forever if
                 * the current request failed.
                 */
                if (self.dashboardRefreshPending) {
                    self.dashboardRefreshPending = false;

                    return self.updateDashboard()
                        .then(
                            function () {
                                throw err;
                            },
                            function () {
                                throw err;
                            }
                        );
                }

                throw err;
            }
        );
    },

    render: function (data) {
        var self = this;

        /*
         * Version is obtained during load().
         */
        if (!self.engineVersion) {
            self.engineVersion =
                parseVersion(
                    data && data[2]
                );
        }

        self.serviceEnabled =
            uci.get(
                'honk',
                'config',
                'enabled'
            ) === '1';

        var css = E(
            'style',
            {},
            '\
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
            .honk-switch:disabled{opacity:.55;cursor:wait} \
            .honk-actions{display:flex;flex-wrap:wrap;gap:10px} \
            .honk-actions .btn:disabled{opacity:.55;cursor:wait} \
            .honk-traffic-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px} \
            .honk-subvalue{margin-top:8px;font-size:16px;font-weight:700;color:var(--text-color-primary,#333)} \
            @media(max-width:640px){.honk-cards,.honk-bottom-row,.honk-traffic-grid{grid-template-columns:1fr}}'
        );

        var viewEl = E(
            'div',
            {
                'class': 'honk-dashboard'
            },
            [
                E(
                    'div',
                    {
                        'class': 'honk-header'
                    },
                    [
                        E(
                            'h1',
                            {},
                            'HONK'
                        ),

                        E(
                            'span',
                            {
                                'id':
                                    'honk_badge',
                                'class':
                                    'honk-badge'
                            },
                            [
                                E(
                                    'span',
                                    {
                                        'class':
                                            'honk-dot'
                                    }
                                ),
                                _('Collecting data...')
                            ]
                        )
                    ]
                ),

                E(
                    'p',
                    {
                        'class':
                            'honk-description'
                    },
                    _(
                        'eBPF-based Linux high-performance transparent proxy solution (HONK engine).'
                    )
                ),

                E(
                    'section',
                    {
                        'class':
                            'honk-cards'
                    },
                    [
                        E(
                            'div',
                            {
                                'class':
                                    'honk-card'
                            },
                            [
                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-label'
                                    },
                                    _('Memory Usage')
                                ),

                                E(
                                    'div',
                                    {
                                        'id':
                                            'honk_memory',
                                        'class':
                                            'honk-value'
                                    },
                                    '--'
                                )
                            ]
                        ),

                        E(
                            'div',
                            {
                                'class':
                                    'honk-card'
                            },
                            [
                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-label'
                                    },
                                    _('Uptime')
                                ),

                                E(
                                    'div',
                                    {
                                        'id':
                                            'honk_uptime',
                                        'class':
                                            'honk-value'
                                    },
                                    '--'
                                )
                            ]
                        ),

                        E(
                            'div',
                            {
                                'class':
                                    'honk-card version'
                            },
                            [
                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-label'
                                    },
                                    _('Engine Version')
                                ),

                                E(
                                    'div',
                                    {
                                        'id':
                                            'honk_version',
                                        'class':
                                            'honk-value'
                                    },
                                    self.engineVersion
                                )
                            ]
                        )
                    ]
                ),

                E(
                    'div',
                    {
                        'class':
                            'honk-bottom-row'
                    },
                    [
                        E(
                            'section',
                            {
                                'class':
                                    'honk-section'
                            },
                            [
                                E(
                                    'h2',
                                    {},
                                    _('Service')
                                ),

                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-service'
                                    },
                                    [
                                        E(
                                            'button',
                                            {
                                                'id':
                                                    'honk_autostart',

                                                'class':
                                                    'honk-switch' +
                                                    (
                                                        self.serviceEnabled
                                                            ? ' on'
                                                            : ''
                                                    ),

                                                'type':
                                                    'button',

                                                'click':
                                                    function (ev) {
                                                        if (
                                                            self.actionBusy
                                                        )
                                                            return;

                                                        ev.currentTarget.disabled =
                                                            true;

                                                        self.setAutostart(
                                                            !self.serviceEnabled
                                                        ).catch(
                                                            function () {
                                                                /*
                                                                 * Notification
                                                                 * is already
                                                                 * handled.
                                                                 */
                                                            }
                                                        );
                                                    }
                                            }
                                        ),

                                        E(
                                            'span',
                                            {},
                                            _('Autostart')
                                        )
                                    ]
                                ),

                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-actions'
                                    },
                                    [
                                        E(
                                            'button',
                                            {
                                                'class':
                                                    'btn cbi-button cbi-button-positive',
                                                'type':
                                                    'button',

                                                'click':
                                                    function (ev) {
                                                        if (
                                                            self.actionBusy
                                                        )
                                                            return;

                                                        ev.currentTarget.disabled =
                                                            true;

                                                        self.handleAction(
                                                            'start'
                                                        ).catch(
                                                            function () {}
                                                        );
                                                    }
                                            },
                                            _('Start')
                                        ),

                                        E(
                                            'button',
                                            {
                                                'class':
                                                    'btn cbi-button cbi-button-apply',
                                                'type':
                                                    'button',

                                                'click':
                                                    function (ev) {
                                                        if (
                                                            self.actionBusy
                                                        )
                                                            return;

                                                        ev.currentTarget.disabled =
                                                            true;

                                                        self.handleAction(
                                                            'restart'
                                                        ).catch(
                                                            function () {}
                                                        );
                                                    }
                                            },
                                            _('Restart')
                                        ),

                                        E(
                                            'button',
                                            {
                                                'class':
                                                    'btn cbi-button cbi-button-negative',
                                                'type':
                                                    'button',

                                                'click':
                                                    function (ev) {
                                                        if (
                                                            self.actionBusy
                                                        )
                                                            return;

                                                        ev.currentTarget.disabled =
                                                            true;

                                                        self.handleAction(
                                                            'stop'
                                                        ).catch(
                                                            function () {}
                                                        );
                                                    }
                                            },
                                            _('Stop')
                                        )
                                    ]
                                )
                            ]
                        ),

                        E(
                            'section',
                            {
                                'class':
                                    'honk-section'
                            },
                            [
                                E(
                                    'h2',
                                    {},
                                    _('Proxy Traffic Stats')
                                ),

                                E(
                                    'div',
                                    {
                                        'class':
                                            'honk-traffic-grid'
                                    },
                                    [
                                        E(
                                            'div',
                                            {
                                                'class':
                                                    'honk-traffic-item'
                                            },
                                            [
                                                E(
                                                    'div',
                                                    {
                                                        'class':
                                                            'honk-label'
                                                    },
                                                    _(
                                                        'Real-time Rate (TX/RX)'
                                                    )
                                                ),

                                                E(
                                                    'div',
                                                    {
                                                        'id':
                                                            'honk_traffic_rate',
                                                        'class':
                                                            'honk-subvalue'
                                                    },
                                                    '0 B/s ↑ / 0 B/s ↓'
                                                )
                                            ]
                                        ),

                                        E(
                                            'div',
                                            {
                                                'class':
                                                    'honk-traffic-item'
                                            },
                                            [
                                                E(
                                                    'div',
                                                    {
                                                        'class':
                                                            'honk-label'
                                                    },
                                                    _(
                                                        'Total Traffic (TX/RX)'
                                                    )
                                                ),

                                                E(
                                                    'div',
                                                    {
                                                        'id':
                                                            'honk_traffic_total',
                                                        'class':
                                                            'honk-subvalue'
                                                    },
                                                    '0 B ↑ / 0 B ↓'
                                                )
                                            ]
                                        )
                                    ]
                                )
                            ]
                        )
                    ]
                )
            ]
        );

        /*
         * Initial refresh.
         */
        self.updateDashboard();

        /*
         * Dynamic data refresh.
         */
        poll.add(
            function () {
                return self.updateDashboard();
            },
            3
        );

        return E(
            'div',
            {},
            [
                css,
                viewEl
            ]
        );
    }
});
