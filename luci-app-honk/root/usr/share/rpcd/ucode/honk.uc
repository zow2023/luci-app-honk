#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
'use strict';

import { readfile, writefile, popen, stat } from 'fs';
import { cursor } from 'uci';

const STATS_URL = 'http://127.0.0.1:9090/stats';

/* ------------------------------------------------------------------ *
 *  Traffic statistics (clash_api on 127.0.0.1:9090)
 * ------------------------------------------------------------------ */

function fetchStats() {
	let fp = popen(`curl -fsS -m 3 ${STATS_URL}`, 'r');
	if (!fp)
		return null;

	let raw = fp.read('all');
	fp.close();

	if (!raw)
		return null;

	try {
		return json(raw);
	}
	catch (e) {
		return null;
	}
}

function get_stats() {
	let data = fetchStats();

	if (!data || type(data.outbounds) != 'array')
		return {};

	let tx = 0;
	let rx = 0;

	for (let ob in data.outbounds) {
		if (!ob)
			continue;

		tx += ob.upload ?? 0;
		rx += ob.download ?? 0;
	}

	return {
		tx_bytes: tx,
		rx_bytes: rx
	};
}

/* ------------------------------------------------------------------ *
 *  Web dashboard (native_api + doona / zashboard static UI)
 *  Ported from QiuSimons/luci-app-honk. The clash_api block is never
 *  touched so that the traffic card keeps working after a switch.
 * ------------------------------------------------------------------ */

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = '9527';
const DEFAULT_SECRET = 'honk114514';

const DASHBOARD_DIRS = {
	zashboard: '/etc/honk/zashboard',
	doona: '/etc/honk/doona'
};

function get_dashboard_dir(type) {
	return DASHBOARD_DIRS[type] || DASHBOARD_DIRS.doona;
}

function is_valid_dashboard_type(type) {
	if (type == 'none')
		return true;

	for (let known in keys(DASHBOARD_DIRS))
		if (known == type)
			return true;

	return false;
}

function is_safe_ui_dir(path) {
	if (!path || !match(path, /^\/etc\/honk\/[^\/]+$/))
		return false;

	let base = substr(path, 10);
	return base != '.' && base != '..';
}

let cached_pid = null;

function is_honk_pid(pid) {
	if (!pid)
		return false;

	let comm = readfile('/proc/' + pid + '/comm');
	if (comm)
		return trim(comm) == 'honk-core';

	let cmd = readfile('/proc/' + pid + '/cmdline');
	return cmd ? match(cmd, /honk-core/) : false;
}

function get_honk_pid() {
	if (cached_pid && is_honk_pid(cached_pid))
		return cached_pid;

	cached_pid = null;

	let p = popen('pidof honk-core 2>/dev/null');
	let pids = p ? p.read('all') : '';
	if (p) p.close();
	let m = match(pids, /([0-9]+)/);
	cached_pid = m ? m[1] : null;
	return cached_pid;
}

function parse_host_port(addr) {
	let res = { host: '', port: '' };
	if (!addr) return res;
	let m_v6 = match(addr, /^\[([^\]]+)\]:([0-9]+)$/);
	let m_v4 = match(addr, /^([^:]+):([0-9]+)$/);
	let m_p = match(addr, /^:([0-9]+)$/);
	if (m_v6) {
		res.host = m_v6[1];
		res.port = m_v6[2];
	} else if (m_v4) {
		res.host = m_v4[1];
		res.port = m_v4[2];
	} else if (m_p) {
		res.host = '0.0.0.0';
		res.port = m_p[1];
	} else if (match(addr, /^[0-9]+$/)) {
		res.host = '0.0.0.0';
		res.port = addr;
	}
	return res;
}

function strip_dae_comments(content) {
	if (!content) return '';
	let lines = split(content, /[\r\n]+/);
	let clean_lines = [];
	for (let idx, line in lines) {
		let in_single = false;
		let in_double = false;
		let clean = '';
		let len = length(line);
		for (let i = 0; i < len; i++) {
			let c = substr(line, i, 1);
			let next_c = (i + 1 < len) ? substr(line, i + 1, 1) : '';
			if (c == "'" && !in_double) {
				in_single = !in_single;
				clean += c;
			} else if (c == '"' && !in_single) {
				in_double = !in_double;
				clean += c;
			} else if (!in_single && !in_double) {
				if (c == '#' || (c == '/' && next_c == '/')) {
					break;
				} else {
					clean += c;
				}
			} else {
				clean += c;
			}
		}
		if (match(clean, /\S/)) {
			push(clean_lines, clean);
		}
	}
	return join('\n', clean_lines);
}

function find_bracket_block(content, header_regex) {
	let lines = split(content, '\n');
	let start_idx = -1;
	let end_idx = -1;
	let in_block = false;
	let depth = 0;
	let in_single = false;
	let in_double = false;

	for (let idx, line in lines) {
		let trimmed = trim(line);
		if (!in_block && match(trimmed, header_regex)) {
			in_block = true;
			start_idx = idx;
		}

		if (in_block) {
			let len = length(line);
			for (let i = 0; i < len; i++) {
				let c = substr(line, i, 1);
				let next_c = (i + 1 < len) ? substr(line, i + 1, 1) : '';
				if (c == "'" && !in_double) {
					in_single = !in_single;
				} else if (c == '"' && !in_single) {
					in_double = !in_double;
				} else if (!in_single && !in_double) {
					if (c == '#' || (c == '/' && next_c == '/')) {
						break;
					} else if (c == '{') {
						depth++;
					} else if (c == '}') {
						depth--;
						if (depth <= 0) {
							end_idx = idx;
							break;
						}
					}
				}
			}
			if (end_idx != -1) break;
		}
	}
	return { start: start_idx, end: end_idx };
}

function extract_bracket_block(content, header_regex) {
	let bounds = find_bracket_block(content, header_regex);
	if (bounds.start == -1 || bounds.end == -1) return null;
	let lines = split(content, '\n');
	let block_lines = [];
	for (let i = bounds.start; i <= bounds.end; i++) {
		push(block_lines, lines[i]);
	}
	return join('\n', block_lines);
}

function remove_bracket_block(content, header_regex) {
	let bounds = find_bracket_block(content, header_regex);
	if (bounds.start == -1 || bounds.end == -1) return content;
	let lines = split(content, '\n');
	let new_lines = [];
	for (let i = 0; i < length(lines); i++) {
		if (i < bounds.start || i > bounds.end) {
			push(new_lines, lines[i]);
		}
	}
	return join('\n', new_lines);
}

function parse_native_api(clean_content) {
	let block = extract_bracket_block(clean_content, /native_api\s*\{/);
	if (!block) return null;

	let listen_m = match(block, /listen\s*:\s*['"]?([^'" \t\r\n]+)['"]?/);
	let ui_m = match(block, /ui\s*:\s*['"]?([^'" \t\r\n]+)['"]?/);
	let sec_m = match(block, /secret\s*:\s*['"]?([^'" \t\r\n]*)['"]?/);
	let en_m = match(block, /enabled\s*:\s*['"]?(true|false)['"]?/);
	let cw_m = match(block, /config_write\s*:\s*['"]?(true|false)['"]?/);

	let res = {
		enabled: en_m ? (en_m[1] == 'true') : true,
		config_write: cw_m ? (cw_m[1] == 'true') : true,
		listen: listen_m ? listen_m[1] : '',
		ui: ui_m ? ui_m[1] : '',
		secret: sec_m ? sec_m[1] : '',
		host: '',
		port: ''
	};

	let hp = parse_host_port(res.listen);
	res.host = hp.host;
	res.port = hp.port;

	return res;
}

function get_config_file_path() {
	let u = cursor();
	let p = null;
	if (u) {
		u.load('honk');
		p = u.get('honk', 'config', 'config_file');
	}
	return p || '/etc/honk/config.dae';
}

function get_api_file_path() {
	return '/etc/honk/config.d/api.dae';
}

function get_api_config() {
	let api_file = get_api_file_path();
	let content = readfile(api_file) || '';
	let clean = strip_dae_comments(content);
	let parsed_native = parse_native_api(clean);

	if (!parsed_native) {
		let config_file = get_config_file_path();
		let legacy_content = readfile(config_file) || '';
		let leg_native = parse_native_api(strip_dae_comments(legacy_content));
		if (leg_native) {
			return {
				file: config_file,
				parsed_native: leg_native,
				is_legacy: true
			};
		}
	}

	return {
		file: api_file,
		parsed_native: parsed_native,
		is_legacy: false
	};
}

function get_uci_dashboard_type(u) {
	if (!u) return null;
	u.load('honk');
	let requested_type = u.get('honk', 'config', 'dashboard');
	if (!requested_type) {
		u.foreach('honk', 'honk', function(s) {
			if (s.dashboard) {
				requested_type = s.dashboard;
				return false;
			}
		});
	}
	return requested_type;
}

function get_dashboard_info(req) {
	let u = cursor();
	let requested_type = (req && req.args) ? req.args.type : null;

	if (!is_valid_dashboard_type(requested_type) && u)
		requested_type = get_uci_dashboard_type(u);

	if (!is_valid_dashboard_type(requested_type))
		requested_type = 'none';

	let api_cfg = get_api_config();
	let parsed = api_cfg.parsed_native;
	let pid = get_honk_pid();

	let res = {
		dashboard_type: requested_type,
		configured: false,
		has_ui: false,
		running: !!pid,
		config_file: api_cfg.file,
		external_controller: '',
		host: '',
		port: '',
		secret: '',
		external_ui: ''
	};

	if (requested_type == 'none')
		return res;

	let target_ui = get_dashboard_dir(requested_type);

	if (parsed && parsed.enabled && parsed.listen) {
		res.external_controller = parsed.listen;
		res.host = parsed.host;
		res.port = parsed.port || DEFAULT_PORT;
		res.secret = parsed.secret;
		res.external_ui = (parsed.ui && is_safe_ui_dir(parsed.ui)) ? parsed.ui : target_ui;

		let s = stat(res.external_ui + '/index.html');
		res.has_ui = (s && s.type == 'file') ? true : false;
		res.configured = res.has_ui;
	}

	return res;
}

function download_dashboard(req) {
	let requested_type = (req && req.args) ? req.args.type : null;
	if (!is_valid_dashboard_type(requested_type))
		requested_type = get_uci_dashboard_type(cursor());
	if (!is_valid_dashboard_type(requested_type) || requested_type == 'none')
		requested_type = 'doona';

	let url = (req && req.args && req.args.url) ? req.args.url : '';
	if (!match(url, /^https?:\/\//) || match(url, /[ \t\r\n'"`]/))
		return { success: false, message: 'Invalid URL' };

	let api_cfg = get_api_config();
	let parsed_native = api_cfg.parsed_native;
	let target_dir = get_dashboard_dir(requested_type);
	if (parsed_native && parsed_native.ui && is_safe_ui_dir(parsed_native.ui))
		target_dir = parsed_native.ui;

	if (!is_safe_ui_dir(target_dir))
		return { success: false, message: 'Refusing to deploy to an unsafe target directory' };

	let script = '/usr/share/honk/download_dashboard.sh';
	if (!stat(script))
		return { success: false, message: 'Script not found: ' + script };

	let safe_script = replace(script, "'", "'\\''");
	let safe_target = replace(target_dir, "'", "'\\''");
	let safe_url = replace(url, "'", "'\\''");

	let cmd = sprintf("/bin/sh '%s' '%s' '%s' >/dev/null 2>&1 &", safe_script, safe_target, safe_url);
	let rc = system(cmd);
	if (rc != 0)
		return { success: false, message: 'failed to dispatch the download task' };

	return { success: true, target_dir: target_dir, url: url, queued: true };
}

function switch_dashboard_api(target_type) {
	cached_pid = null;

	if (!is_valid_dashboard_type(target_type))
		return { success: false, message: 'Invalid dashboard type' };

	let api_file = get_api_file_path();
	let api_cfg = get_api_config();
	let parsed_native = api_cfg.parsed_native;

	system('mkdir -p /etc/honk/config.d');

	let u = cursor();
	if (u) {
		u.load('honk');
		let sid = 'config';
		if (!u.get('honk', sid))
			u.foreach('honk', 'honk', function(s) { sid = s['.name']; });
		u.set('honk', sid, 'dashboard', target_type || 'none');
		u.commit('honk');
	}

	/* "none": drop the native_api block, keep everything else untouched */
	if (target_type == 'none' || !target_type) {
		let content = readfile(api_file) || '';
		let cleaned = remove_bracket_block(content, /^[#\/]*\s*native_api\s*\{/);
		if (cleaned != content) {
			writefile(api_file, cleaned);
			system('/etc/init.d/honk restart >/dev/null 2>&1 &');
			return { success: true, type: 'none', queued: true };
		}
		return { success: true, type: 'none' };
	}

	let target_ui = get_dashboard_dir(target_type);
	let s = stat(target_ui + '/index.html');
	let has_ui = (s && s.type == 'file') ? true : false;

	/* UI files missing: do not point honk at a non-existent directory */
	if (!has_ui && parsed_native && parsed_native.enabled && parsed_native.listen)
		return { success: true, type: target_type, has_ui: false, pending_download: true };

	/* already correct */
	if (parsed_native && parsed_native.enabled && parsed_native.listen &&
	    parsed_native.config_write && parsed_native.ui == target_ui && has_ui)
		return { success: true, type: target_type, has_ui: true };

	let content = readfile(api_file) || '';
	let sec = (parsed_native && parsed_native.secret && length(parsed_native.secret) >= 8)
		? parsed_native.secret : DEFAULT_SECRET;
	let listen = (parsed_native && parsed_native.listen)
		? parsed_native.listen : (DEFAULT_HOST + ':' + DEFAULT_PORT);

	/* strip only native_api blocks — clash_api (traffic stats) is preserved */
	let cleaned = content;
	for (let iter = 0; iter < 10; iter++) {
		let before = cleaned;
		cleaned = remove_bracket_block(cleaned, /^[#\/]*\s*native_api\s*\{/);
		if (cleaned == before)
			break;
	}

	let ui_line = has_ui ? ("        ui: '" + target_ui + "'\n") : '';

	let native_block =
		'    native_api {\n' +
		'        enabled: true\n' +
		"        listen: '" + listen + "'\n" +
		"        secret: '" + sec + "'\n" +
		ui_line +
		'        config_write: true\n' +
		'    }\n';

	let base = trim(cleaned);
	let exp_block = base ? extract_bracket_block(base, /experimental\s*\{/) : null;
	let new_content;

	if (exp_block) {
		/* append native_api inside the existing experimental {} block */
		let exp_t = trim(exp_block);
		let head = substr(exp_t, 0, length(exp_t) - 1);
		let rebuilt = head + native_block + '}';
		new_content = replace(base, exp_t, rebuilt);
	} else if (base != '') {
		new_content = base + '\n\nexperimental {\n' + native_block + '}\n';
	} else {
		new_content = '# api.dae\n# Native API access for HONK web dashboards.\n\n' +
			'experimental {\n' + native_block + '}\n';
	}

	writefile(api_file, new_content);
	system('/etc/init.d/honk restart >/dev/null 2>&1 &');

	return { success: true, type: target_type, has_ui: has_ui, queued: true };
}

return {
	honk: {
		getStats: {
			call: function () {
				return get_stats();
			}
		}
	},

	'luci.honk': {
		status: {
			call: function () {
				let pid = get_honk_pid();
				let running = !!pid;
				let memory = null;

				if (running) {
					let status_str = readfile('/proc/' + pid + '/status');
					if (status_str) {
						let rss_m = match(status_str, /VmRSS:\s+([0-9]+)\s+kB/);
						if (rss_m)
							memory = sprintf('%.1f MB', +rss_m[1] / 1024);
					}
				}

				return { running: running, memory: memory };
			}
		},

		reload: {
			call: function () {
				cached_pid = null;

				let rc = system('/etc/init.d/honk hot_reload >/dev/null 2>&1 &');
				if (rc != 0)
					return { success: false, message: 'failed to dispatch hot_reload' };

				return { success: true, queued: true };
			}
		},

		restart: {
			call: function () {
				cached_pid = null;

				let rc = system('/etc/init.d/honk restart >/dev/null 2>&1 &');
				if (rc != 0)
					return { success: false, message: 'failed to dispatch restart' };

				return { success: true, queued: true };
			}
		},

		get_log: {
			call: function () {
				let p = popen('tail -n 1000 /var/log/honk/honk.log 2>/dev/null');
				let content = p ? p.read('all') : '';
				if (p) p.close();
				return { log: content || '' };
			}
		},

		clear_log: {
			call: function () {
				system('mkdir -p /var/log/honk');
				writefile('/var/log/honk/honk.log', '');
				return { success: true };
			}
		},

		get_dashboard_info: {
			args: { type: 'string' },
			call: get_dashboard_info
		},

		download_dashboard: {
			args: { url: 'string', type: 'string' },
			call: download_dashboard
		},

		download_status: {
			call: function () {
				let status_raw = readfile('/tmp/honk_dashboard_download.status') || 'IDLE';
				let log = readfile('/tmp/honk_dashboard_download.log') || '';
				let status_m = match(status_raw, /\S+/);
				let status = status_m ? status_m[0] : 'IDLE';
				return { status: status, log: log };
			}
		},

		switch_dashboard_api: {
			args: { type: 'string' },
			call: function (req) {
				let t = req.args ? req.args.type : 'none';
				return switch_dashboard_api(t);
			}
		}
	}
};
