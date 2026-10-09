// SPDX-License-Identifier: Apache-2.0

'use strict';
'require fs';
'require rpc';
'require uci';
'require ui';
'require view';

var DEFAULT_CONFIG_PATH = '/etc/honk/config.dae';

var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

return view.extend({
    editorInstance: null,

    // [fix] 防抖：避免双击按钮导致并发 fs.write / restart 相互踩踏
    actionBusy: false,

    // [fix] 实际配置路径：跟随 UCI config_file，回退到默认值，
    //       避免编辑器写 A 文件、服务加载 B 文件的静默错位
    configPath: null,

    load: function () {
        var self = this;
        return uci.load('honk').then(function () {
            self.configPath = uci.get('honk', 'config', 'config_file') || DEFAULT_CONFIG_PATH;
            return L.resolveDefault(fs.read_direct(self.configPath, 'text'), '');
        });
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

        /* 链式串行加载，确保 CodeMirror 插件按依赖顺序执行（防止 foldgutter 抢先于 foldcode 加载报错） */
        return loadScript('/luci-static/resources/honk/lib/codemirror.js')
            .then(function () { return loadScript('/luci-static/resources/honk/addon/edit/matchbrackets.js'); })
            .then(function () { return loadScript('/luci-static/resources/honk/addon/fold/foldcode.js'); })
            .then(function () { return loadScript('/luci-static/resources/honk/addon/fold/foldgutter.js'); })
            .then(function () { return loadScript('/luci-static/resources/honk/addon/fold/indent-fold.js'); })
            .then(function () { return loadScript('/luci-static/resources/honk/mode/dae/dae.js'); });
    },

    mountEditor: function (content) {
        var self = this;

        return self.loadAssets().then(function () {
            /* 在 Promise 异步完成后获取 textarea，防止 DOM 尚未渲染导致 null 异常 */
            var textarea = document.getElementById('honk-config-editor');
            if (!textarea) return;

            if (self.editorInstance) {
                self.editorInstance.setValue(content || '');
                return;
            }

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
                if (self.editorInstance)
                    self.editorInstance.refresh();
            }, 100);
        });
    },

    // [fix] 视图卸载时销毁 CodeMirror 实例（toTextArea 还原 textarea 并解绑
    //       全部事件监听与 undo 历史），避免 SPA 导航反复进出造成累积泄漏。
    //       loadAssets 注入的 <link>/<script> 有去重守卫，故意保留复用。
    destroy: function () {
        if (this.editorInstance) {
            try { this.editorInstance.toTextArea(); } catch (e) {}
            this.editorInstance = null;
        }
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

            /* 使用 replaceRange 替换文本，保留 CodeMirror 的撤销/重做 历史栈 */
            var lastLine = editor.lineCount() - 1;
            var lastChar = editor.getLine(lastLine).length;
            editor.replaceRange(formatted.join('\n'), { line: 0, ch: 0 }, { line: lastLine, ch: lastChar });

            for (var i = 0; i < editor.lineCount(); i++)
                editor.indentLine(i, 'smart');
            editor.setCursor(cursor);
        });
    },

    getEditorValue: function () {
        return this.editorInstance ? this.editorInstance.getValue() : ((document.getElementById('honk-config-editor') || {}).value || '');
    },

    execServiceAction: function (action) {
        return fs.exec('/etc/init.d/honk', [action]).then(function (res) {
            if (res && typeof res.code !== 'undefined' && res.code !== 0)
                return Promise.reject(new Error((res.stderr || res.stdout || (action + ' failed')).trim()));
            return res;
        });
    },

    // [fix] Reload 成功与否不再只看 init 脚本退出码（procd restart 异步，
    //       退出码 0 ≠ 服务起来了）：延迟后通过 service.list 验证实际运行
    //       状态，配置被 honk-core 拒绝时给出明确报错而非假阳性通知
    handleReloadService: function () {
        var self = this;
        ui.showModal(_('Reloading...'), [
            E('p', { 'class': 'spinning' }, _('Reloading service configuration...'))
        ]);

        return self.execServiceAction('reload')
            .then(function () {
                /* procd restart 是异步的：先等它落定再查状态 */
                return new Promise(function (resolve) { window.setTimeout(resolve, 1500); });
            })
            .then(function () {
                return L.resolveDefault(callServiceList('honk'), {});
            })
            .then(function (res) {
                ui.hideModal();

                var instances = res && res.honk && res.honk.instances;
                var running = !!(instances && Object.keys(instances).some(function (key) {
                    return instances[key].running;
                }));

                if (running)
                    ui.addNotification(null, E('p', _('Service reloaded successfully.')), 'info');
                else
                    ui.addNotification(null, E('p', _(
                        'Reload finished but honk is not running. The new configuration was probably rejected; check the log.'
                    )), 'error');
            })
            .catch(function (err) {
                ui.hideModal();
                ui.addNotification(null, E('p', _('Reload failed: %s').format(err.message || err)), 'error');
            });
    },

    // [fix] busy 期间统一禁用工具栏按钮
    setToolbarDisabled: function (disabled) {
        var buttons = document.querySelectorAll('.honk-toolbar button');
        for (var i = 0; i < buttons.length; i++)
            buttons[i].disabled = disabled;
    },

    savePage: function (applyChanges) {
        var self = this;

        /* [fix] 防抖：动作进行中直接忽略后续触发 */
        if (self.actionBusy)
            return Promise.resolve();
        self.actionBusy = true;
        self.setToolbarDisabled(true);

        var content = self.getEditorValue().replace(/\r\n?/g, '\n');
        if (!content.trim()) {
            ui.addNotification(null, E('p', _('Configuration cannot be empty!')), 'error');
            self.actionBusy = false;
            self.setToolbarDisabled(false);
            return Promise.reject(new Error('Empty configuration'));
        }

        /* 改用 LuCI 原生 fs 模块写文件，解决自定义 callFileWrite 可能引发的 ACL 权限异常 */
        /* [fix] 写入路径跟随 UCI config_file，与 init 脚本实际加载的文件保持一致 */
        return fs.write(self.configPath || DEFAULT_CONFIG_PATH, content).then(function () {
            if (!applyChanges) {
                ui.addNotification(null, E('p', _('Configuration saved.')), 'info');
                return null;
            }
            return self.handleReloadService();
        }).catch(function (err) {
            ui.addNotification(null, E('p', _('Failed to save configuration: %s').format(err.message || err)), 'error');
            throw err;
        }).finally(function () {
            /* [fix] 无论成败都恢复按钮与防抖标志（finally 在旧引擎上由 LuCI 的
                     Promise polyfill 覆盖，可用） */
            self.actionBusy = false;
            self.setToolbarDisabled(false);
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

        /* [fix] load() 现在直接返回文件内容字符串（UCI 路径已存入 self.configPath） */
        var content = data || '';

        var css = E('style', {}, '\
            .honk-editor-page{max-width:1000px} \
            .honk-editor-page .hint{margin:0 0 16px;color:var(--text-color-secondary,#666)} \
            .honk-card{margin-bottom:18px;padding:18px;border:1px solid var(--border-color-medium,#d9d9d9);border-radius:12px;background:var(--background-color-primary,#fff)} \
            .honk-card h3{margin:0 0 12px;font-size:18px} \
            .honk-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px} \
            .CodeMirror{border:1px solid #6272a4;border-radius:8px;min-height:480px;font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important} \
            .CodeMirror pre.CodeMirror-line,.CodeMirror pre.CodeMirror-line-like,.CodeMirror-lines,.CodeMirror-line,.CodeMirror-code{font-family:Monaco,Consolas,monospace !important;font-size:13px !important;line-height:1.5 !important;letter-spacing:0 !important}'
        );

        var root = E('div', { 'class': 'honk-editor-page' }, [
            E('h2', {}, _('Global Settings')),
            E('p', { 'class': 'hint' }, _('Configure global settings for HONK.')),
            E('div', { 'class': 'honk-card' }, [
                E('h3', {}, _('Global Configuration')),
                E('p', { 'class': 'hint' }, _('Correctly configure the include field for separate-config to work, or enter complete configuration here.')),
                E('div', { 'class': 'honk-toolbar' }, [
                    E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-neutral', 'click': function () { self.formatCode(); } }, _('Format Code')),
                    E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-apply', 'click': function () { self.savePage(true).catch(function () {}); } }, _('Reload Service'))
                ]),
                E('textarea', { 'id': 'honk-config-editor', 'style': 'width:100%;min-height:480px' }, content)
            ])
        ]);

        /* [fix] mountEditor 失败（任一 CodeMirror 脚本加载失败）不再静默：
                 提示用户编辑器未加载，原始 textarea 仍可正常编辑保存（降级可用） */
        window.setTimeout(function () {
            self.mountEditor(content).catch(function (err) {
                ui.addNotification(null, E('p', _(
                    'Failed to load the code editor (%s); the plain textarea is still usable.'
                ).format(err.message || err)), 'error');
            });
        }, 0);

        return E('div', {}, [css, root]);
    }
});
