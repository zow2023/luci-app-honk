// SPDX-License-Identifier: Apache-2.0

'use strict';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view';

var callFileWrite = rpc.declare({
    object: 'file',
    method: 'write',
    params: ['path', 'data'],
    expect: { result: false }
});

var CONFIG_PATH = '/etc/honk/config.dae';

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
            self.editorInstance = CodeMirror.fromTextArea(textarea, {
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
            var formatted = lines.map(function (line) {
                if (line.trim().indexOf('#') === 0 || line.trim().indexOf('//') === 0)
                    return line;
                line = line.replace(/\s*->\s*/g, ' -> ');
                line = line.replace(/\s*&&\s*/g, ' && ');
                return line.replace(/\s+$/, '');
            });
            editor.setValue(formatted.join('\n'));
            for (var i = 0; i < editor.lineCount(); i++)
                editor.indentLine(i, 'smart');
            editor.setCursor(cursor);
        });
    },

    getEditorValue: function () {
        return this.editorInstance ? this.editorInstance.getValue() : (document.getElementById('honk-config-editor') || {}).value || '';
    },

    savePage: function (applyChanges) {
        var content = this.getEditorValue().replace(/\r\n?/g, '\n');
        if (!content.trim()) {
            ui.addNotification(null, E('p', _('Configuration cannot be empty!')), 'error');
            return Promise.reject(new Error('Empty configuration'));
        }

        var enabled = document.getElementById('honk-enabled').checked ? '1' : '0';
        var autoUpdate = document.getElementById('honk-auto-update').checked ? '1' : '0';
        var weekTime = document.getElementById('honk-week-time').value;
        var dayTime = document.getElementById('honk-day-time').value;

        uci.set('honk', 'config', 'enabled', enabled);
        uci.set('honk', 'config', 'subscribe_auto_update', autoUpdate);
        uci.set('honk', 'config', 'subscribe_update_week_time', weekTime);
        uci.set('honk', 'config', 'subscribe_update_day_time', dayTime);

        return uci.save().then(function () {
            return callFileWrite(CONFIG_PATH, content);
        }).then(function () {
            if (!applyChanges)
                return null;
            return uci.apply().then(function () {
                return fs.exec('/etc/init.d/honk', [enabled === '1' ? 'enable' : 'disable']);
            }).then(function () {
                return fs.exec('/etc/init.d/honk', [enabled === '1' ? 'restart' : 'stop']);
            });
        }).then(function () {
            ui.addNotification(null, E('p', applyChanges ? _('Configuration saved and applied.') : _('Configuration saved.')), 'info');
        }).catch(function (err) {
            ui.addNotification(null, E('p', _('Failed to save configuration: %s').format(err.message || err)), 'error');
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

    render: function (data) {
        var self = this;
        var content = data[1] || '';
        var autoUpdate = uci.get('honk', 'config', 'subscribe_auto_update') === '1';
        var currentWeek = uci.get('honk', 'config', 'subscribe_update_week_time') || '*';
        var currentHour = uci.get('honk', 'config', 'subscribe_update_day_time') || '0';
        var weekOptions = [
            ['*', _('Every Day')], ['1', _('Every Monday')], ['2', _('Every Tuesday')], ['3', _('Every Wednesday')],
            ['4', _('Every Thursday')], ['5', _('Every Friday')], ['6', _('Every Saturday')], ['0', _('Every Sunday')]
        ];
        var hourOptions = [];
        for (var i = 0; i < 24; i++)
            hourOptions.push(E('option', { 'value': String(i), 'selected': String(i) === String(currentHour) }, i + ':00'));

        var css = E('style', {}, '\
            .honk-editor-page{max-width:1000px} \
            .honk-editor-page .hint{margin:0 0 16px;color:var(--text-color-secondary,#666)} \
            .honk-card{margin-bottom:18px;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)} \
            .honk-card h3{margin:0 0 12px;font-size:18px} \
            .honk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px} \
            .honk-field label{display:block;margin-bottom:6px;font-weight:700} \
            .honk-checkbox{display:flex;align-items:center;gap:8px;min-height:42px} \
            .honk-select{width:100%;padding:7px 10px} \
            .honk-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px} \
            .CodeMirror{border:1px solid #6272a4;border-radius:8px;min-height:480px;font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important} \
            .CodeMirror pre.CodeMirror-line,.CodeMirror pre.CodeMirror-line-like,.CodeMirror-lines,.CodeMirror-line,.CodeMirror-code{font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important;letter-spacing:0 !important}'
        );

        var root = E('div', { 'class': 'honk-editor-page' }, [
            E('h2', {}, _('Global Settings')),
            E('p', { 'class': 'hint' }, _('Configure global settings for HONK.')),
            E('div', { 'class': 'honk-card' }, [
                E('h3', {}, _('基础设置')),
                E('div', { 'class': 'honk-grid' }, [
                    E('div', { 'class': 'honk-field honk-checkbox' }, [E('input', { 'id': 'honk-enabled', 'type': 'checkbox', 'checked': uci.get('honk', 'config', 'enabled') === '1' }), E('label', { 'for': 'honk-enabled' }, _('Enabled'))]),
                    E('div', { 'class': 'honk-field honk-checkbox' }, [E('input', { 'id': 'honk-auto-update', 'type': 'checkbox', 'checked': autoUpdate }), E('label', { 'for': 'honk-auto-update' }, _('Enable Auto Subscribe Update'))]),
                    E('div', { 'class': 'honk-field' }, [E('label', { 'for': 'honk-week-time' }, _('Update Cycle')), E('select', { 'id': 'honk-week-time', 'class': 'cbi-input-select honk-select' }, weekOptions.map(function (item) { return E('option', { 'value': item[0], 'selected': item[0] === currentWeek }, item[1]); }))]),
                    E('div', { 'class': 'honk-field' }, [E('label', { 'for': 'honk-day-time' }, _('Update Time (Every Day)')), E('select', { 'id': 'honk-day-time', 'class': 'cbi-input-select honk-select' }, hourOptions)])
                ])
            ]),
            E('div', { 'class': 'honk-card' }, [
                E('h3', {}, _('Global Configuration')),
                E('p', { 'class': 'hint' }, _('Correctly configure the include field for separate-config to work, or enter complete configuration here.')),
                E('div', { 'class': 'honk-toolbar' }, [
                    E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-neutral', 'click': function () { self.formatCode(); } }, _('Format Code')),
                    E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-apply', 'click': function () { fs.exec('/etc/init.d/honk', ['hot_reload']); } }, _('Reload Service'))
                ]),
                E('textarea', { 'id': 'honk-config-editor', 'style': 'width:100%;min-height:480px' }, content)
            ])
        ]);

        window.setTimeout(function () {
            self.mountEditor(content);
            var autoUpdateEl = document.getElementById('honk-auto-update');
            var toggleDeps = function () {
                var disabled = !document.getElementById('honk-auto-update').checked;
                document.getElementById('honk-week-time').disabled = disabled;
                document.getElementById('honk-day-time').disabled = disabled;
            };
            if (autoUpdateEl)
                autoUpdateEl.addEventListener('change', toggleDeps);
            toggleDeps();
        }, 0);

        return E('div', {}, [css, root]);
    }
});
