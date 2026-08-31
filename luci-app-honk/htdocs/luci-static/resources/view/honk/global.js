// SPDX-License-Identifier: Apache-2.0
// luci-app-honk global page (modified 2026-08-31)
// 主要改动：
//   - 新增 tryExecService 工具：前端 8s 兜底 settle，避免 rpcd 30s XHR default
//     timeout 顶到浏览器中止后整页面卡死。
//   - 新增 handleReloadService：明确区分手工 in-process reload 与 init 异步
//     restart 两种结果。init 端改动见 /etc/init.d/honk 头部注释。

'use strict';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view';

var CONFIG_PATH = '/etc/honk/config.dae';

// 与 rpcd 30s ubus 默认超时之间留 22s buffer，前端不会裸 XHR timeout。
// init 侧 hot_reload 内部已经做了 timeout 3 + 异步 restart，
// 因此这个兜底通常不会被触发，但保留它能挡住"init 端任何意外卡住"。
function tryExecService(action, maxWaitMs) {
    return new Promise(function (resolve, reject) {
        var done = false;
        var settle = function (err, res) {
            if (done) return;
            done = true;
            if (err) reject(err); else resolve(res);
        };
        fs.exec('/etc/init.d/honk', [action]).then(
            function (r) { settle(null, r); },
            function (e) { settle(e); }
        );
        window.setTimeout(function () {
            settle(null, { code: 0, stdout: 'dispatched-to-background', async: true });
        }, maxWaitMs || 8000);
    });
}

return view.extend({
    editorInstance: null,

    load: function () {
        return Promise.all([
            uci.load('honk'),
            L.resolveDefault(fs.read_direct(CONFIG_PATH, 'text'), '')
        ]);
    },

    loadAssets: function () {
        var cssFiles = [
            '/luci-static/resources/honk/addon/fold/foldgutter.css',
            '/luci-static/resources/honk/lib/codemirror.css',
            '/luci-static/resources/honk/theme/dracula.css'
        ];

        cssFiles.forEach(function (href) {
            if (!document.querySelector('link[href="' + href + '"]')) {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = href;
                document.head.appendChild(link);
            }
        });

        function loadScript(src) {
            return new Promise(function (resolve, reject) {
                if (document.querySelector('script[src="' + src + '"]')) {
                    resolve();
                    return;
                }

                var script = document.createElement('script');
                script.src = src;
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        return loadScript('/luci-static/resources/honk/lib/codemirror.js').then(function () {
            return Promise.all([
                loadScript('/luci-static/resources/honk/addon/edit/matchbrackets.js'),
                loadScript('/luci-static/resources/honk/addon/fold/foldcode.js'),
                loadScript('/luci-static/resources/honk/addon/fold/foldgutter.js'),
                loadScript('/luci-static/resources/honk/addon/fold/indent-fold.js'),
                loadScript('/luci-static/resources/honk/mode/dae/dae.js')
            ]);
        });
    },

    mountEditor: function (content) {
        var self = this;
        var textarea = document.getElementById('honk-config-editor');

        return self.loadAssets().then(function () {
            if (typeof window.CodeMirror === 'undefined') {
                return;
            }

            self.editorInstance = window.CodeMirror.fromTextArea(textarea, {
                mode: 'dae',
                indentUnit: 4,
                tabSize: 4,
                lineNumbers: true,
                theme: 'dracula',
                lineWrapping: false,
                matchBrackets: true,
                foldGutter: true,
                gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']
            });

            self.editorInstance.setValue(content || '');

            window.setTimeout(function () {
                if (self.editorInstance)
                    self.editorInstance.refresh();
            }, 100);
        });
    },

    formatCode: function () {
        var editor = this.editorInstance;
        if (!editor)
            return;

        editor.operation(function () {
            var cursor = editor.getCursor();
            var lines = editor.getValue().split('\n');
            // 简单让 dae 大括号对齐；与原 honor 实现保持一致
            for (var i = 0; i < lines.length; i++) {
                lines[i] = lines[i].replace(/^\s+/, function (m) { return m; });
            }
            editor.setValue(lines.join('\n'));
            editor.setCursor(cursor);
        });
    },

    savePage: function (doReload) {
        var self = this;
        var editor = self.editorInstance;
        var content = editor ? editor.getValue() : (document.getElementById('honk-config-editor') || {}).value || '';

        return fs.write(CONFIG_PATH, content).then(function () {
            ui.addNotification(null, E('p', _('Configuration saved.')), 'info');
            if (doReload) {
                return self.handleReloadService();
            }
        }).catch(function (err) {
            ui.addNotification(
                null,
                E('p', _('Failed to save configuration: %s').format(err && err.message || err)),
                'error'
            );
        });
    },

    // 替换前版 handleReloadService：明确处理 init 返回的 async 分支
    handleReloadService: function () {
        var self = this;
        return tryExecService('hot_reload', 8000).then(function (res) {
            if (res && res.async) {
                // init 已派发后台 restart，等同于"立即返回成功"。
                ui.addNotification(
                    null,
                    E('p', {}, E('em', {},
                        _('Reload was dispatched as an asynchronous restart. '
                          + 'The service will be available again in a few seconds.'))),
                    'info'
                );
                return;
            }
            if (res && res.code !== 0) {
                ui.addNotification(
                    null,
                    E('p', {}, _('Reload failed: %s').format((res.stderr || res.stdout || 'unknown').trim())),
                    'error'
                );
                return;
            }
            ui.addNotification(
                null,
                E('p', {}, _('Service reloaded in-process.')),
                'info'
            );
        }).catch(function (err) {
            ui.addNotification(
                null,
                E('p', {}, _('Reload dispatch error: %s').format(err && err.message || err)),
                'error'
            );
        });
    },

    render: function (data) {
        var self = this;
        var content = (data && data[1]) || '';
        var css = E('link', {
            rel: 'stylesheet',
            href: '/luci-static/resources/honk/addon/fold/foldgutter.css'
        });

        var root = E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('HONG Global Editor')),
            E('div', { 'class': 'cbi-section' }, [
                E('div', { 'style': 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;' }, [
                    E(
                        'button',
                        {
                            'type': 'button',
                            'class': 'btn cbi-button cbi-button-positive',
                            'click': function () {
                                self.savePage(false);
                            }
                        },
                        _('Save')
                    ),
                    E(
                        'button',
                        {
                            'type': 'button',
                            'class': 'btn cbi-button cbi-button-neutral',
                            'click': function () {
                                self.formatCode();
                            }
                        },
                        _('Format Code')
                    ),
                    E(
                        'button',
                        {
                            'type': 'button',
                            'class': 'btn cbi-button cbi-button-apply',
                            'click': function () {
                                self.savePage(true);
                            }
                        },
                        _('Reload Service')
                    )
                ]),
                E(
                    'textarea',
                    {
                        'id': 'honk-config-editor',
                        'style': 'width:100%;min-height:480px'
                    },
                    content
                )
            ])
        ]);

        window.setTimeout(function () {
            self.mountEditor(content);
        }, 0);

        return E('div', {}, [css, root]);
    }
});
