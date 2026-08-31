// SPDX-License-Identifier: Apache-2.0

'use strict';
'require dom';
'require fs';
'require poll';
'require rpc';
'require ui';
'require view';

var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

var LOG_PATH = '/var/log/honk/honk.log';
var MAX_LINES = 2000;

return view.extend({
    isPaused: false,
    rawLogLines: [],
    lastRawContent: null,

    isServiceRunning: function () {
        return L.resolveDefault(
            callServiceList('honk'),
            {}
        ).then(function (svc) {
            return !!(
                svc &&
                svc.honk &&
                svc.honk.instances &&
                svc.honk.instances.honk &&
                svc.honk.instances.honk.running
            );
        });
    },

    renderBlank: function () {
        var logText = document.getElementById('log_textarea');

        if (!logText)
            return;

        dom.content(logText, E('pre', {}, [
            E('div', {
                'style': 'text-align:center;color:#888;padding:20px;'
            }, _('Log is empty or service stopped.'))
        ]));
    },

    escapeHtml: function (str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    },

    formatLogLine: function (line) {
        /*
         * Escape the original log content before inserting controlled
         * HTML markup. This prevents log content from being interpreted
         * as HTML.
         */
        var escaped = this.escapeHtml(line);

        var regex =
            /(\b\d{1,3}(?:\.\d{1,3}){3}\b)|(\blevel=(error|warn|warning|info|debug)\b)|(\b(?:error|failed|warn|warning|info|debug)\b)/gi;

        return '<div class="log-container">' +
            escaped.replace(
                regex,
                function (match, ip, levelPair, levelVal, keyword) {
                    if (ip)
                        return '<span class="log-ip">' + ip + '</span>';

                    if (levelPair) {
                        var cls = levelVal.toLowerCase();

                        if (cls === 'warning')
                            cls = 'warn';

                        return 'level=<span class="log-' +
                            cls +
                            '">' +
                            levelVal +
                            '</span>';
                    }

                    if (keyword) {
                        var kwCls = keyword.toLowerCase();

                        if (kwCls === 'failed')
                            kwCls = 'error';

                        if (kwCls === 'warning')
                            kwCls = 'warn';

                        return '<span class="log-' +
                            kwCls +
                            '">' +
                            keyword +
                            '</span>';
                    }

                    return match;
                }
            ) +
            '</div>';
    },

    /*
     * Keep the debounce timer inside the returned function's closure.
     * This prevents different debounce instances from sharing a timer.
     */
    debounce: function (fn, wait) {
        var timer = null;

        return function () {
            var ctx = this;
            var args = arguments;

            clearTimeout(timer);

            timer = window.setTimeout(function () {
                fn.apply(ctx, args);
            }, wait);
        };
    },

    /*
     * Filter raw log lines in memory and rebuild the DOM once.
     *
     * This avoids creating one DOM update per log entry and prevents
     * the large style/reflow cost of hiding thousands of elements
     * individually.
     */
    renderFilteredLog: function () {
        var logText = document.getElementById('log_textarea');

        if (!logText)
            return;

        var filterInput = document.getElementById('filterInput');
        var filter = filterInput
            ? filterInput.value.trim().toLowerCase()
            : '';

        var htmlBuffer = [];

        for (var i = 0; i < this.rawLogLines.length; i++) {
            var line = this.rawLogLines[i];

            if (
                !filter ||
                line.toLowerCase().indexOf(filter) !== -1
            ) {
                htmlBuffer.push(this.formatLogLine(line));
            }
        }

        var pre = E('pre');

        /*
         * formatLogLine() has already escaped the original log data.
         * Only the controlled span/div markup is inserted here.
         */
        pre.innerHTML = htmlBuffer.join('');

        dom.content(logText, pre);
    },

    refreshLog: function () {
        var self = this;
        var logText = document.getElementById('log_textarea');

        /*
         * Do not start a new refresh if the view is no longer present
         * or automatic refresh has been paused.
         */
        if (!logText || self.isPaused)
            return Promise.resolve();

        return self.isServiceRunning().then(function (running) {
            if (!running) {
                self.rawLogLines = [];
                self.lastRawContent = null;
                self.renderBlank();

                return;
            }

            /*
             * Only read the newest MAX_LINES lines.
             *
             * This avoids loading the complete log file into JavaScript
             * memory on low-resource OpenWrt devices.
             */
            return fs.exec(
                '/usr/bin/tail',
                ['-n', String(MAX_LINES), LOG_PATH]
            ).then(function (res) {
                if (!res || res.code !== 0) {
                    throw new Error(
                        (res && res.stderr) ||
                        _('Failed to read log file.')
                    );
                }

                var content = res.stdout || '';

                /*
                 * Avoid rebuilding the DOM when the log has not changed.
                 */
                if (self.lastRawContent === content)
                    return;

                self.lastRawContent = content;

                if (!content) {
                    self.rawLogLines = [];
                } else {
                    self.rawLogLines = content.split(/\r?\n/);

                    /*
                     * tail normally returns a trailing newline.
                     * Remove only that artificial empty entry rather
                     * than using trim(), which could alter meaningful
                     * whitespace in the log.
                     */
                    if (
                        self.rawLogLines.length &&
                        self.rawLogLines[self.rawLogLines.length - 1] === ''
                    ) {
                        self.rawLogLines.pop();
                    }

                    /*
                     * Newest log entry first.
                     */
                    self.rawLogLines.reverse();
                }

                self.renderFilteredLog();
            });
        }).catch(function (err) {
            var currentLogText =
                document.getElementById('log_textarea');

            if (!currentLogText)
                return;

            dom.content(
                currentLogText,
                E(
                    'pre',
                    {},
                    _('Error loading log: %s').format(
                        err.message || err
                    )
                )
            );
        });
    },

    clearLog: function () {
        var self = this;

        if (!window.confirm(
            _('Are you sure you want to clear the log file?')
        )) {
            return Promise.resolve();
        }

        return fs.write(LOG_PATH, '').then(function () {
            self.rawLogLines = [];
            self.lastRawContent = null;

            var logText = document.getElementById('log_textarea');

            if (logText)
                dom.content(logText, E('pre', {}, ''));

            ui.addNotification(
                null,
                E('p', _('Log cleared successfully.')),
                'info'
            );
        }).catch(function (err) {
            ui.addNotification(
                null,
                E(
                    'p',
                    _('Failed to clear log: %s').format(
                        err.message || err
                    )
                ),
                'error'
            );
        });
    },

    render: function () {
        var self = this;

        var css = E('style', {}, '\
            #log_textarea{text-align:left;max-height:70vh;min-height:200px;overflow-y:auto;color-scheme:light dark;background-color:#f8f9fa;border-radius:8px;border:1px solid #ddd;font-size:13px;box-shadow:0 2px 5px rgba(0,0,0,0.05)} \
            #log_textarea pre{padding:.7rem;word-break:break-all;margin:0;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;line-height:1.4} \
            .log-info{color:#0366d6}.log-warn{color:#f59f00}.log-error{color:#d73a49;font-weight:bold}.log-debug{color:#6f42c1}.log-ip{color:#22863a;font-weight:bold} \
            .log-container{padding:2px 0}.log-container:hover{background-color:rgba(0,0,0,0.03)} \
            .controls-container{margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px}.controls-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}.controls-row:last-child{margin-bottom:0} \
            #filterInput{max-width:220px;flex:1;min-width:140px;padding:5px;border-radius:4px;border:1px solid #ddd} \
            @media (prefers-color-scheme: dark){#log_textarea{background-color:#252a30;border-color:#444;color:#e6e6e6}.log-container:hover{background-color:rgba(255,255,255,0.05)}.log-info{color:#58a6ff}.log-warn{color:#ffab70}.log-error{color:#f97583}.log-debug{color:#d2a8ff}.log-ip{color:#7ee787}#filterInput{background-color:#252a30;border-color:#444;color:#e6e6e6}} \
            @media (min-width: 768px){.controls-container{flex-direction:row;flex-wrap:nowrap}.controls-row{margin-bottom:0;flex:1}.controls-row:first-child{flex:2}}'
        );

        var filterInput = E('input', {
            'id': 'filterInput',
            'type': 'text',
            'placeholder': _('Filter logs...'),
            'input': self.debounce(function () {
                self.renderFilteredLog();
            }, 200)
        });

        var root = E('div', { 'class': 'cbi-map' }, [
            E('div', { 'class': 'controls-container' }, [
                E('div', { 'class': 'controls-row' }, [
                    filterInput,

                    E('button', {
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            filterInput.value = '';
                            self.renderFilteredLog();
                        }
                    }, _('Clear Filter')),

                    E('button', {
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function (ev) {
                            /*
                             * Use currentTarget rather than target.
                             * target may point to a child element if the
                             * button later contains nested elements.
                             */
                            var btn = ev.currentTarget;

                            self.isPaused = !self.isPaused;

                            btn.innerHTML = self.isPaused
                                ? '▶ ' + _('Resume Refresh')
                                : '⏸ ' + _('Pause Refresh');

                            btn.className = self.isPaused
                                ? 'btn cbi-button cbi-button-positive'
                                : 'btn cbi-button cbi-button-neutral';
                        }
                    }, '⏸ ' + _('Pause Refresh'))
                ]),

                E('div', { 'class': 'controls-row' }, [
                    E('button', {
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText =
                                document.getElementById('log_textarea');

                            if (logText)
                                logText.scrollTop = 0;
                        }
                    }, _('Scroll to newest')),

                    E('button', {
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText =
                                document.getElementById('log_textarea');

                            if (logText)
                                logText.scrollTop =
                                    logText.scrollHeight;
                        }
                    }, _('Scroll to oldest')),

                    E('button', {
                        'class': 'btn cbi-button cbi-button-negative',
                        'type': 'button',
                        'click': function () {
                            self.clearLog();
                        }
                    }, _('Clear Log'))
                ])
            ]),

            E('div', { 'class': 'cbi-section' }, [
                E(
                    'div',
                    { 'id': 'log_textarea' },
                    E('pre', {}, '')
                ),

                E(
                    'div',
                    {
                        'style': 'text-align:right;margin-top:5px'
                    },
                    E(
                        'small',
                        {},
                        _('Refresh every 5 seconds.')
                    )
                )
            ])
        ]);

        self.refreshLog();

        poll.add(function () {
            return self.refreshLog();
        }, 5);

        return E('div', {}, [css, root]);
    }
});
