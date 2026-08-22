#!/usr/bin/ucode
'use strict';

import { popen } from 'fs';

const STATS_URL = 'http://127.0.0.1:9090/stats';

function fetchStats() {
	let fp = popen(sprintf('curl -s -m 3 %s', STATS_URL), 'r');
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

const methods = {
	getStats: {
		call: function () {
			let data = fetchStats();

			if (!data || !data.outbounds)
				return { tx_bytes: 0, rx_bytes: 0 };

			let tx = 0, rx = 0;

			for (let ob in data.outbounds) {
				tx += ob.upload || 0;
				rx += ob.download || 0;
			}

			return { tx_bytes: tx, rx_bytes: rx };
		}
	}
};

if (ARGV[0] == 'list') {
	let rv = {};
	for (let name in methods)
		rv[name] = methods[name].args || {};
	print(sprintf('%.J\n', rv));
}
else if (ARGV[0] == 'call') {
	let result = null, code = 0;

	if (methods[ARGV[1]])
		result = methods[ARGV[1]].call();
	else
		code = 4; // UBUS_STATUS_METHOD_NOT_FOUND

	print(sprintf('%.J\n', result));
	exit(code);
}
