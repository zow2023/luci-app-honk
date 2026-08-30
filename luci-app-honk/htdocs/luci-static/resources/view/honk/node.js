// SPDX-License-Identifier: Apache-2.0

'use strict';
'require fs';
'require ui';
'require view';

var CONFIG_PATH = '/etc/honk/config.d/node.dae';

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
                E('p', _('Failed to load CodeMirror resources: %s').format(
                    err.message || err
                )),
                'error'
            );
        });
    },

    formatCode: function () {
        var editor = this.editorInstance;

        if (!editor)
            return;

        function formatLine(line) {
            var result = '';
            var quote = null;
            var escaped = false;
            var i = 0;

            while (i < line.length) {
                var ch = line[i];

                if (quote) {
                    result += ch;

                    if (escaped) {
                        escaped = false;
                    } else if (ch === '\\') {
                        escaped = true;
                    } else if (ch === quote) {
                        quote = null;
                    }

                    i++;
                    continue;
                }

                if (ch === '"' || ch === "'") {
                    quote = ch;
                    result += ch;
                    i++;
                    continue;
                }

                if (ch === '#') {
                    result += line.slice(i);
                    break;
                }

                if (ch === '-' && line[i + 1] === '>') {
                    result = result.replace(/\s+$/, '');
                    result += ' -> ';
                    i += 2;

                    while (i < line.length && /\s/.test(line[i]))
                        i++;

                    continue;
                }

                if (ch === '&' && line[i + 1] === '&') {
                    result = result.replace(/\s+$/, '');
                    result += ' && ';
                    i += 2;

                    while (i < line.length && /\s/.test(line[i]))
                        i++;

                    continue;
                }

                result += ch;
                i++;
            }

            return result.replace(/\s+$/, '');
        }

        editor.operation(function () {
            var cursor = editor.getCursor();
            var lines = editor.getValue().split('\n');

            var formatted = lines.map(function (line) {
                if (line.trim().indexOf('#') === 0 ||
                    line.trim().indexOf('//') === 0)
                    return line;

                return formatLine(line);
            });

            editor.setValue(formatted.join('\n'));

            for (var i = 0; i < editor.lineCount(); i++)
                editor.indentLine(i, 'smart');

            editor.setCursor(cursor);
        });
    },

    getEditorValue: function () {
        return this.editorInstance ?
            this.editorInstance.getValue() :
            (document.getElementById('honk-editor') || {}).value || '';
    },

    execServiceAction: function (action) {
        return fs.exec('/etc/init.d/honk', [action]).then(function (res) {
            if (res && typeof res.code !== 'undefined' && res.code !== 0)
                return Promise.reject(new Error(
                    (res.stderr || res.stdout || (action + ' failed')).trim()
                ));

            return res;
        });
    },

    handleReloadService: function () {
        var self = this;

        ui.showModal(_('Reloading...'), [
            E('p', { 'class': 'spinning' },
                _('Reloading service configuration...'))
        ]);

        return self.execServiceAction('reload').then(function () {
            ui.hideModal();
            ui.addNotification(
                null,
                E('p', _('Service reloaded successfully.')),
                'info'
            );
        }).catch(function (err) {
            ui.hideModal();
            ui.addNotification(
                null,
                E('p', _('Reload failed: %s').format(err.message || err)),
                'error'
            );
        });
    },

    savePage: function (applyChanges) {
        var self = this;
        var content = self.getEditorValue().replace(/\r\n?/g, '\n');

        if (!content.trim()) {
            ui.addNotification(
                null,
                E('p', _('Configuration cannot be empty!')),
                'error'
            );
            return Promise.reject(new Error('Empty configuration'));
        }

        return fs.write(CONFIG_PATH, content).then(function () {
            if (applyChanges)
                return self.handleReloadService();

            ui.addNotification(
                null,
                E('p', _('Configuration saved.')),
                'info'
            );
        }).catch(function (err) {
            ui.addNotification(
                null,
                E('p', _('Failed to save configuration: %s').format(
                    err.message || err
                )),
                'error'
            );
            throw err;
        });
    },

    handleSave: function () {
        return this.savePage(false);
    },

    handleSaveApply: function () {
        return this.savePage(true);
    },

    handleReset: function () {
        window.location.reload();
    },

    render: function (content) {
        var self = this;

        var css = E('style', {}, '\
            .honk-editor-page{max-width:1000px}\
            .honk-editor-page .hint{margin:0 0 16px;color:var(--text-color-secondary,#666)}\
            .honk-card{margin-bottom:18px;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)}\
            .honk-card h3{margin:0 0 12px;font-size:18px}\
            .honk-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px}\
            .CodeMirror{border:1px solid #6272a4;border-radius:8px;min-height:480px;font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important}\
            .CodeMirror pre.CodeMirror-line,.CodeMirror pre.CodeMirror-line-like,.CodeMirror-lines,.CodeMirror-line,.CodeMirror-code{font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important;letter-spacing:0 !important}'
        );

        var root = E('div', { 'class': 'honk-editor-page' }, [
            E('h2', {}, _('Node Settings')),
            E('p', { 'class': 'hint' },
                _('Configure nodes and groups for HONK.')),
            E('div', { 'class': 'honk-card' }, [
                E('div', { 'class': 'honk-toolbar' }, [
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
                E('h3', {}, _('Node Configuration')),
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
