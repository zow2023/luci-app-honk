#!/usr/bin/ucode
// SPDX-License-Identifier: Apache-2.0
'use strict';

import { popen } from 'fs';

const STATS_URL = 'http://127.0.0.1:9090/stats';

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

return {
	honk: {
		getStats: {
			call: function () {
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
		}
	}
};
