// SPDX-License-Identifier: Apache-2.0

'use strict';

'require dom';
'require fs';
'require poll';
'require ui';
'require view';

var LOG_PATH = '/var/log/honk/honk.log';
var MAX_SAFE_SIZE = 200 * 1024;
var MAX_DISPLAY_LINES = 1000;
var MAX_TAIL_BYTES = 64 * 1024; // 64KB 足够展示 1000 行日志

return view.extend({
    isPaused: false,
    lastLogSize: null,
    lastLogMtime: null,
    logEntriesCache: null,
    refreshInProgress: false,
    loadError: null,
    _pollHandle: null,

    /*
     * 公共读取函数：根据 stat 结果读取日志内容。
     * 小文件直接全量读取，大文件只取尾部，并跳过首个可能不完整的行。
     */
    _fetchLogContent: function (stat) {
        if (stat.size <= MAX_SAFE_SIZE) {
            return fs.read_direct(LOG_PATH, 'text').then(function (content) {
                return content || '';
            });
        }

        return fs.exec('/usr/bin/tail', [
            '-c', String(MAX_TAIL_BYTES), LOG_PATH
        ]).then(function (res) {
            if (!res || res.code !== 0) {
                return '';
            }

            var content = res.stdout || '';
            var firstNewline = content.indexOf('\n');

            return firstNewline >= 0
                ? content.substring(firstNewline + 1)
                : content;
        });
    },

    /*
     * load() 钩子：在 render 之前预取日志内容，提升首屏加载体验。
     */
    load: function () {
        var self = this;

        return fs.stat(LOG_PATH).then(function (stat) {
            if (!stat || stat.size === 0) {
                self.lastLogSize = 0;
                self.lastLogMtime = null;
                return '';
            }

            self.lastLogSize  = String(stat.size);
            self.lastLogMtime = stat.mtime !== undefined
                ? String(stat.mtime)
                : '';

            return self._fetchLogContent(stat);
        }).catch(function (err) {
            // 记录错误，稍后在 render 中展示，不阻塞页面加载
            self.loadError = err;
            return '';
        });
    },

    formatLogLine: function (line) {
        line = String(line || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        var regex = /(\b\d{1,3}(?:\.\d{1,3}){3}\b)|(\blevel=(error|warn|warning|info|debug)\b)|(\b(?:error|failed|warn|warning|info|debug)\b)/gi;

        line = line.replace(regex, function (match, ip, levelPair, levelVal, keyword) {
            if (ip)
                return '<span class="log-ip">' + ip + '</span>';

            if (levelPair) {
                var cls = levelVal.toLowerCase();

                if (cls === 'warning')
                    cls = 'warn';

                return 'level=<span class="log-' + cls + '">' +
                    levelVal + '</span>';
            }

            if (keyword) {
                var kwCls = keyword.toLowerCase();

                if (kwCls === 'failed')
                    kwCls = 'error';

                if (kwCls === 'warning')
                    kwCls = 'warn';

                return '<span class="log-' + kwCls + '">' +
                    keyword + '</span>';
            }

            return match;
        });

        return '<div class="log-container">' + line + '</div>';
    },

    debounce: function (fn, wait) {
        var timer = null;

        return function () {
            var args = arguments;
            var ctx = this;

            clearTimeout(timer);

            timer = window.setTimeout(function () {
                fn.apply(ctx, args);
            }, wait);
        };
    },

    cacheLogEntries: function () {
        if (this.logEntriesCache)
            return this.logEntriesCache;

        var logContainer = document.getElementById('log_textarea');

        if (!logContainer)
            return [];

        var entries = logContainer.querySelectorAll('.log-container');
        var cache = new Array(entries.length);

        for (var i = 0; i < entries.length; i++) {
            cache[i] = {
                element: entries[i],
                text: entries[i].textContent.toLowerCase()
            };
        }

        this.logEntriesCache = cache;
        return cache;
    },

    clearFilterHighlights: function (element) {
        if (!element || !element.querySelector('.filter-highlight'))
            return;

        var marks = element.querySelectorAll('.filter-highlight');

        for (var i = 0; i < marks.length; i++) {
            var mark = marks[i];
            var parent = mark.parentNode;

            if (!parent)
                continue;

            parent.replaceChild(
                document.createTextNode(mark.textContent),
                mark
            );

            parent.normalize();
        }
    },

    highlightFilter: function (element, filter) {
        if (!element || !filter)
            return;

        var safeFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var regex = new RegExp(safeFilter, 'gi');
        var walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            null
        );
        var nodes = [];
        var node;

        while ((node = walker.nextNode()) !== null) {
            if (node.parentNode &&
                node.parentNode.classList &&
                node.parentNode.classList.contains('filter-highlight'))
                continue;

            regex.lastIndex = 0;

            if (regex.test(node.nodeValue))
                nodes.push(node);
        }

        for (var i = 0; i < nodes.length; i++) {
            node = nodes[i];

            var text = node.nodeValue;
            regex.lastIndex = 0;

            var fragment = document.createDocumentFragment();
            var lastIndex = 0;
            var match;

            while ((match = regex.exec(text)) !== null) {
                if (match.index > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(
                            text.substring(lastIndex, match.index)
                        )
                    );
                }

                var mark = document.createElement('span');
                mark.className = 'filter-highlight';
                mark.textContent = match[0];
                fragment.appendChild(mark);

                lastIndex = match.index + match[0].length;

                if (match[0].length === 0)
                    regex.lastIndex++;
            }

            if (lastIndex < text.length) {
                fragment.appendChild(
                    document.createTextNode(text.substring(lastIndex))
                );
            }

            node.parentNode.replaceChild(fragment, node);
        }
    },

    applyFilter: function (filter) {
        var self = this;
        var logContainer = document.getElementById('log_textarea');

        if (!logContainer)
            return;

        filter = (filter || '').trim().toLowerCase();

        var entries = this.cacheLogEntries();

        window.requestAnimationFrame(function () {
            for (var i = 0; i < entries.length; i++) {
                var entry = entries[i];

                self.clearFilterHighlights(entry.element);

                if (!filter) {
                    entry.element.style.display = '';
                    continue;
                }

                if (entry.text.indexOf(filter) !== -1) {
                    entry.element.style.display = '';
                    self.highlightFilter(entry.element, filter);
                } else {
                    entry.element.style.display = 'none';
                }
            }
        });
    },

    readLog: function () {
        var self = this;

        return fs.stat(LOG_PATH).then(function (stat) {
            if (!stat || stat.size === 0) {
                var changed = self.lastLogSize !== 0;

                self.lastLogSize  = 0;
                self.lastLogMtime = null;

                return { changed: changed, content: '' };
            }

            var size  = String(stat.size);
            var mtime = stat.mtime !== undefined ? String(stat.mtime) : '';

            if (self.lastLogSize === size && self.lastLogMtime === mtime)
                return { changed: false, content: null };

            self.lastLogSize  = size;
            self.lastLogMtime = mtime;

            return self._fetchLogContent(stat).then(function (content) {
                return { changed: true, content: content };
            });
        });
    },

    renderLog: function (content) {
        content = content || '';

        // 保留行内空白，仅移除首尾空行
        var lines = content.split(/\r?\n/);

        // 去掉首尾的空字符串（可能由开头或结尾的换行产生）
        while (lines.length > 0 && lines[0] === '')
            lines.shift();
        while (lines.length > 0 && lines[lines.length - 1] === '')
            lines.pop();

        if (lines.length > MAX_DISPLAY_LINES)
            lines = lines.slice(-MAX_DISPLAY_LINES);

        lines.reverse();

        var formatted = new Array(lines.length);

        for (var i = 0; i < lines.length; i++)
            formatted[i] = this.formatLogLine(lines[i]);

        var logText = document.getElementById('log_textarea');

        if (!logText)
            return;

        var pre = E('pre');
        pre.innerHTML = formatted.join('') || _('Log is empty.');

        dom.content(logText, pre);
        this.logEntriesCache = null;

        var filterInput = document.getElementById('filterInput');

        if (filterInput && filterInput.value)
            this.applyFilter(filterInput.value);
    },

    refreshLog: function () {
        var self = this;
        var logText = document.getElementById('log_textarea');

        if (!logText || self.isPaused || self.refreshInProgress)
            return Promise.resolve();

        self.refreshInProgress = true;

        return self.readLog().then(function (result) {
            if (!result || result.changed === false)
                return;

            self.renderLog(result.content);
        }).catch(function (err) {
            var currentLogText = document.getElementById('log_textarea');

            if (currentLogText) {
                dom.content(
                    currentLogText,
                    E('pre', {}, _('Unknown error: %s').format(
                        err.message || err
                    ))
                );
            }
        }).finally(function () {
            self.refreshInProgress = false;
        });
    },

    clearLog: function () {
        var self = this;

        if (!window.confirm(_('Are you sure you want to clear the log file?')))
            return Promise.resolve();

        return fs.write(LOG_PATH, '').then(function () {
            self.lastLogSize  = 0;
            self.lastLogMtime = null;
            self.logEntriesCache = null;

            var logText = document.getElementById('log_textarea');

            if (logText)
                dom.content(logText, E('pre', {}, ''));

            // 清除后无需再发起 RPC，直接更新界面即可
            ui.addNotification(
                null,
                E('p', {}, _('Log cleared successfully.')),
                'info'
            );
        }).catch(function (err) {
            ui.addNotification(
                null,
                E('p', {}, _('Failed to clear log: %s').format(
                    err.message || err
                )),
                'error'
            );
        });
    },

    render: function (initialContent) {
        var self = this;

        var css = E('style', {}, '\
            #log_textarea{text-align:left;max-height:70vh;min-height:200px;overflow-y:auto;color-scheme:light dark;background-color:#f8f9fa;border-radius:8px;border:1px solid #ddd;font-size:13px;box-shadow:0 2px 5px rgba(0,0,0,0.05)} \
            #log_textarea pre{padding:.7rem;word-break:break-all;margin:0;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;line-height:1.4} \
            .log-info{color:#0366d6}.log-warn{color:#f59f00}.log-error{color:#d73a49;font-weight:bold}.log-debug{color:#6f42c1}.log-ip{color:#22863a;font-weight:bold} \
            .log-container{padding:2px 0}.log-container:hover{background-color:rgba(0,0,0,0.03)} \
            .filter-highlight{background-color:#ffeb3b;color:#000;padding:0 2px;border-radius:3px;font-weight:bold} \
            .controls-container{margin-bottom:15px;display:flex;flex-wrap:wrap;gap:10px}.controls-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}.controls-row:last-child{margin-bottom:0} \
            #filterInput{max-width:220px;flex:1;min-width:140px;padding:5px;border-radius:4px;border:1px solid #ddd} \
            #log_textarea::-webkit-scrollbar{width:10px} \
            #log_textarea::-webkit-scrollbar-track{background:rgba(0,0,0,0.03);border-radius:4px} \
            #log_textarea::-webkit-scrollbar-thumb{background:rgba(0,0,0,0.15);border-radius:4px;border:2px solid #f8f9fa} \
            #log_textarea::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,0.25)} \
            @media (prefers-color-scheme:dark){#log_textarea{background-color:#252a30;border-color:#444;color:#e6e6e6}.log-container:hover{background-color:rgba(255,255,255,0.05)}.filter-highlight{background-color:#b58b00;color:#fff}.log-info{color:#58a6ff}.log-warn{color:#ffab70}.log-error{color:#f97583}.log-debug{color:#d2a8ff}.log-ip{color:#7ee787}#filterInput{background-color:#252a30;border-color:#444;color:#e6e6e6}#log_textarea::-webkit-scrollbar-track{background:rgba(255,255,255,0.03)}#log_textarea::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.15);border-color:#252a30}#log_textarea::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.25)}} \
            @media (min-width:768px){.controls-container{flex-direction:row;flex-wrap:nowrap}.controls-row{margin-bottom:0;flex:1}.controls-row:first-child{flex:2}}'
        );

        var filterInput = E('input', {
            'id': 'filterInput',
            'type': 'text',
            'placeholder': _('Filter logs...')
        });

        filterInput.addEventListener(
            'input',
            self.debounce(function () {
                self.applyFilter(filterInput.value);
            }, 150)
        );

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
                            var btn = ev.currentTarget || ev.target;
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
                        'id': 'scrollUpButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText = document.getElementById('log_textarea');

                            if (logText)
                                logText.scrollTop = 0;
                        }
                    }, _('Scroll to head')),

                    E('button', {
                        'id': 'scrollDownButton',
                        'class': 'btn cbi-button cbi-button-neutral',
                        'type': 'button',
                        'click': function () {
                            var logText = document.getElementById('log_textarea');

                            if (logText)
                                logText.scrollTop = logText.scrollHeight;
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
                E(
                    'div',
                    { 'id': 'log_textarea' },
                    E('pre', {}, '')
                ),

                E(
                    'div',
                    { 'style': 'text-align:right;margin-top:5px' },
                    E(
                        'small',
                        {},
                        _('Refresh every %s seconds.')
                            .format(L.env.pollinterval)
                    )
                )
            ])
        ]);

        // 初始渲染：如果加载出错则显示错误，否则渲染预取的内容
        window.requestAnimationFrame(function () {
            if (self.loadError) {
                var logText = document.getElementById('log_textarea');
                if (logText) {
                    dom.content(
                        logText,
                        E('pre', {}, _('Failed to load log: %s').format(
                            self.loadError.message || self.loadError
                        ))
                    );
                }
                return;
            }
            self.renderLog(initialContent);
        });

        // 启动轮询，并保存句柄以便在视图销毁时移除
        this._pollHandle = poll.add(function () {
            var logText = document.getElementById('log_textarea');

            // 如果 DOM 元素已不存在（视图切换），停止轮询
            if (!logText) {
                if (self._pollHandle) {
                    self._pollHandle.remove();
                    self._pollHandle = null;
                }
                return Promise.resolve();
            }

            return self.refreshLog();
        }, L.env.pollinterval);

        return E('div', {}, [
            css,
            E('h2', {}, [_('Log')]),
            root
        ]);
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
