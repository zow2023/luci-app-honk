#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
'use strict';

import { popen } from 'fs';

const STATS_URL = 'http://127.0.0.1:9090/stats';

function fetchStats() {
	let fp = popen(`curl -s -m 3 ${STATS_URL}`, 'r');
	if (!fp)
		return null;

	let raw = fp.read('all');
	fp.close();

	if (!raw)
		return null;

	let data;
	try {
		data = json(raw);
	} catch (e) {
		return null;
	}

	return data;
}

/*
 * ucode rpcd 插件必须在文件顶层 return 一个签名对象：
 * { ubus对象名: { 方法名: { call: function(request) {...} } } }
 */
return {
	honk: {
		getStats: {
			call: function () {
				let data = fetchStats();

				if (!data || !data.outbounds)
					return { tx_bytes: 0, rx_bytes: 0 };

				let tx = 0, rx = 0;

				for (let ob in data.outbounds) {
					tx += ob.upload ?? 0;
					rx += ob.download ?? 0;
				}

				return { tx_bytes: tx, rx_bytes: rx };
			}
		}
	}
};
