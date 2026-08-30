// SPDX-License-Identifier: Apache-2.0

'use strict';
'require dom';
'require fs';
'require poll';
'require rpc';
'require ui';
'require view';

var callFileWrite = rpc.declare({
    object: 'file',
    method: 'write',
    params: ['path', 'data'],
    expect: { result: false }
});

var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

var LOG_PATH = '/var/log/honk/honk.log';

return view.extend({
    isPaused: false,
    originalLogContent: '',
    logEntriesCache: null,
    debounceTimer: null,
    lastLogRawContent: null,
    maxDisplayLines: 5000,

    isServiceRunning: function () {
        return L.resolveDefault(callServiceList('honk'), {}).then(function (svc) {
            try {
                return !!svc.honk.instances.honk.running;
            } catch (e) {
                return false;
            }
        });
    },

    renderBlank: function () {
        var logText = document.getElementById('log_textarea');
        if (!logText) return;
        var pre = E('pre');
        pre.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">' + 
                      _('Log is empty.') + 
                      '</div>';
        dom.content(logText, pre);
    },

    formatLogLine: function (line) {
        line = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        line = line.replace(/\b(error|failed)\b/g, '<span class="log-error">$1</span>')
            .replace(/\b(warn|warning)\b/g, '<span class="log-warn">$1</span>')
            .replace(/\b(info|INFO)\b/g, '<span class="log-info">$1</span>')
            .replace(/\b(debug|DEBUG)\b/g, '<span class="log-debug">$1</span>')
            .replace(/\blevel=(error|warn|info|debug)\b/g, 'level=<span class="log-$1">$1</span>')
            .replace(/(\b\d{1,3}(?:\.\d{1,3}){3}\b)/g, '<span class="log-ip">$1</span>');
        return '<div class="log-container">' + line + '</div>';
    },

    debounce: function (fn, wait) {
        var self = this;
        return function () {
            var args = arguments;
            var ctx = this;
            clearTimeout(self.debounceTimer);
            self.debounceTimer = window.setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    },

    highlightFilter: function (text, filter) {
        if (!filter) return text;
        var safe = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return text.replace(new RegExp('(' + safe + ')', 'gi'), '<span class="filter-highlight">$1</span>');
    },

    cacheLogEntries: function () {
        if (this.logEntriesCache) return this.logEntriesCache;
        var logContainer = document.getElementById('log_textarea');
        var entries = logContainer ? logContainer.querySelectorAll('.log-container') : [];
        var cache = [];
        for (var i = 0; i < entries.length; i++)
            cache.push({ element: entries[i], text: entries[i].textContent.toLowerCase(), originalHtml: entries[i].innerHTML });
        this.logEntriesCache = cache;
        return cache;
    },

    applyFilter: function (filter) {
        var logContainer = document.getElementById('log_textarea');
        if (!logContainer) return;
        if (!filter) {
            var pre = logContainer.querySelector('pre');
            if (pre) {
                pre.innerHTML = this.originalLogContent || '';
                this.logEntriesCache = null;
            }
            return;
        }
        filter = filter.toLowerCase();
        var entries = this.cacheLogEntries();
        var self = this;
        window.requestAnimationFrame(function () {
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].text.indexOf(filter) !== -1) {
                    entries[i].element.innerHTML = self.highlightFilter(entries[i].originalHtml, filter);
                    entries[i].element.style.display = '';
                } else {
                    entries[i].element.style.display = 'none';
                }
            }
        });
    },

    renderLog: function (content) {
        content = content || '';

        // Avoid rebuilding the DOM when the log file has not changed.
        if (this.lastLogRawContent === content)
            return;

        this.lastLogRawContent = content;

        var lines = content.trim() ? content.trim().split(/\r?\n/) : [];

        // Keep the web page responsive when the log file becomes very large.
        // The log file itself is never modified; only the displayed lines are limited.
        if (lines.length > this.maxDisplayLines)
            lines = lines.slice(-this.maxDisplayLines);

        lines.reverse();

        var formatted = [];
        for (var i = 0; i < lines.length; i++)
            formatted.push(this.formatLogLine(lines[i]));

        this.originalLogContent = formatted.join('');
        this.logEntriesCache = null;

        var logText = document.getElementById('log_textarea');
        if (!logText) return;

        var pre = E('pre');
        pre.innerHTML = this.originalLogContent || '';
        dom.content(logText, pre);

        var filterInput = document.getElementById('filterInput');
        if (filterInput && filterInput.value)
            this.applyFilter(filterInput.value);
    },

    refreshLog: function () {
        var self = this;
        if (self.isPaused) return Promise.resolve();

        return self.isServiceRunning().then(function (running) {
            if (!running) {
                self.originalLogContent = '';
                self.logEntriesCache = null;
                self.lastLogRawContent = null;
                self.renderBlank();
                return;
            }

            return L.resolveDefault(fs.read_direct(LOG_PATH, 'text'), '').then(function (content) {
                self.renderLog(content);
            });
        }).catch(function (err) {
            var logText = document.getElementById('log_textarea');
            if (logText)
                dom.content(logText, E('pre', {}, _('Unknown error: %s').format(err)));
        });
    },

    clearLog: function () {
        var self = this;
        if (!window.confirm(_('Are you sure you want to clear the log file?'))) return Promise.resolve();
        return callFileWrite(LOG_PATH, '').then(function () {
            self.originalLogContent = '';
            self.logEntriesCache = null;
            self.lastLogRawContent = null;
            var logText = document.getElementById('log_textarea');
            if (logText) dom.content(logText, E('pre', {}, ''));
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
            .filter-highlight{background-color:#ffeb3b;color:#000;padding:0 2px;border-radius:3px;font-weight:bold} \
            @media (prefers-color-scheme: dark){#log_textarea{background-color:#252a30;border-color:#444;color:#e6e6e6}.log-container:hover{background-color:rgba(255,255,255,0.05)}.filter-highlight{background-color:#b58b00;color:#fff}.log-info{color:#58a6ff}.log-warn{color:#ffab70}.log-error{color:#f97583}.log-debug{color:#d2a8ff}.log-ip{color:#7ee787}#filterInput{background-color:#252a30;border-color:#444;color:#e6e6e6}} \
            @media (min-width: 768px){.controls-container{flex-direction:row;flex-wrap:nowrap}.controls-row{margin-bottom:0;flex:1}.controls-row:first-child{flex:2}}'
        );

        var filterInput = E('input', {
            'id': 'filterInput',
            'type': 'text',
            'placeholder': _('Filter logs...'),
            'input': self.debounce(function (ev) {
                self.applyFilter(ev.target.value);
            }, 200)
        });

        var root = E('div', { 'class': 'cbi-map' }, [
            E('div', { 'class': 'controls-container' }, [
                E('div', { 'class': 'controls-row' }, [
                    filterInput,
                    E('button', {
                        'id': 'clearFilterButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            filterInput.value = '';
                            self.applyFilter('');
                            self.logEntriesCache = null;
                        }
                    }, _('Clear Filter')),
                    E('button', {
                        'id': 'refreshToggleButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function (ev) {
                            self.isPaused = !self.isPaused;
                            ev.target.innerHTML = (self.isPaused ? '▶ ' + _('Resume Refresh') : '⏸ ' + _('Pause Refresh'));
                            ev.target.className = self.isPaused ? 'btn cbi-button cbi-button-positive' : 'btn cbi-button cbi-button-neutral';
                        }
                    }, '⏸ ' + _('Pause Refresh'))
                ]),
                E('div', { 'class': 'controls-row' }, [
                    E('button', {
                        'id': 'scrollUpButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText = document.getElementById('log_textarea');
                            if (logText) logText.scrollTop = 0;
                        }
                    }, _('Scroll to head')),
                    E('button', {
                        'id': 'scrollDownButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText = document.getElementById('log_textarea');
                            if (logText) logText.scrollTop = logText.scrollHeight;
                        }
                    }, _('Scroll to tail')),
                    E('button', {
                        'id': 'clearLogButton',
                        'class': 'btn cbi-button cbi-button-negative',
                        'type': 'button',
                        'click': function () {
                            self.clearLog();
                        }
                    }, _('Clear Log'))
                ])
            ]),
            E('div', { 'class': 'cbi-section' }, [
                E('div', { 'id': 'log_textarea' }, E('pre', {}, '')),
                E('div', { 'style': 'text-align:right;margin-top:5px' }, E('small', {}, _('Refresh every 5 seconds.')))
            ])
        ]);

        self.refreshLog();
        poll.add(function () { return self.refreshLog(); }, 2);

        return E('div', {}, [css, root]);
    }
});
