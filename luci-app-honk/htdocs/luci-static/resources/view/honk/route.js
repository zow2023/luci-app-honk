// SPDX-License-Identifier: Apache-2.0
// luci-app-honk Route page (modified 2026-08-31)
// 与 dns.js / node.js 同一组改动。

'use strict';
'require fs';
'require ui';
'require view';

var CONFIG_PATH = '/etc/honk/config.d/route.dae';

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
        return L.resolveDefault(fs.read_direct(CONFIG_PATH, 'text'), '');
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
                script.onerror = function () {
                    reject(new Error('Failed to load ' + src));
                };
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
        var textarea = document.getElementById('honk-editor');

        if (!textarea)
            return Promise.resolve();

        return self.loadAssets().then(function () {
            if (typeof window.CodeMirror === 'undefined') {
                ui.addNotification(
                    null,
                    E('p', _('Failed to load CodeMirror resources.')),
                    'error'
                );
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

            window.setTimeout(function () {
                if (self.editorInstance)
                    self.editorInstance.refresh();
            }, 100);
        }).catch(function (err) {
            ui.addNotification(
                null,
                E('p', _('Failed to load CodeMirror resources: %s').format(err && err.message || err)),
                'error'
            );
        });
    },

    formatCode: function () {
        var editor = this.editorInstance;
        if (!editor)
            return;

        editor.operation(function () {
            var cursor = editor.getCursor();
            var lines = editor.getValue().split('\n');
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
        var content = editor ? editor.getValue() : (document.getElementById('honk-editor') || {}).value || '';

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

    handleReloadService: function () {
        return tryExecService('hot_reload', 8000).then(function (res) {
            if (res && res.async) {
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
        var content = '';
        if (typeof data === 'string') content = data;
        else if (data && typeof data === 'object') content = data.content || '';

        var css = E('link', {
            rel: 'stylesheet',
            href: '/luci-static/resources/honk/addon/fold/foldgutter.css'
        });

        var root = E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('HONK Route Editor')),
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
                        'id': 'honk-editor',
                        'style': 'width:100%;min-height:480px'
                    },
                    content || ''
                )
            ])
        ]);

        window.setTimeout(function () {
            self.mountEditor(content || '');
        }, 0);

        return E('div', {}, [css, root]);
    }
});
