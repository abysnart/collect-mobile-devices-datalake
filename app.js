const _https = require('https');
const _path = require('path');
const _fs = require('fs');
const _stream = require('stream');
const puppeteer = require('puppeteer');
const _log = _fs.createWriteStream('./log/debug'+Date.now()+'.log', {flags : 'w'});
const test_url = 'https://google.com';
const mysql = require('mysql');
const mysql_max_rows = 150;
const pool = mysql.createPool({
  host     : '',
  user     : '',
  password : '',
  database : '',
  insecureAuth: true,
  multipleStatements: true
});
pool.getConnection(function(err , connection) {
  if(err){
    console.log(err.code);
    console.log(err.fatal)
  } else console.log('Connect to database');
  if (connection) connection.release();
  return true;
});
const do_query = (query) => {
	if(!pool) {
		console.log('Pool do not exists');
		return false;
	}
	return new Promise ((resolve, reject) => pool.query(query, (err, rows, fields) => {
    if(err) reject(err);
    resolve(rows)
	}))
}

const logg = (message, console=false) => {
	if(console) console.log(message);
	let time = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
	_log.write(`${time}: ${message}\n`);
};

const open_page = async (url, _browser = null, custom_request=null) => {
	if(!url) return false;
	let browser = _browser, page, status;
	const blocked_rs = ['image','media','font','texttrack','object','beacon','csp_report','imageset','stylesheet'];
	const skipped_rs = ['ampproject','openx','amazon-adsystem','gstatic','quantserve','adzerk','doubleclick','cloudfont','adition','exelator','sharethrough','cdn.api.twitter','google-analytics','googletagmanager','fontawesome','facebook','ebay','analytics','optimizely','clicktale','mixpanel','zedo','clicksor','tiqcdn','adrecover'];
	if(browser == null) {
		try {
			browser = await puppeteer.launch({headless:true, args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--deterministic-fetch',
				"--proxy-server='direct://'",
				'--proxy-bypass-list=*',
				'--disable-dev-shm-usage',
				'--disable-accelerated-2d-canvas',
			]});
			page = await browser.newPage();
		} catch(e) {
			logg('Error: Cant start puppeteer '+e);
			return false;
		}
	} else {
		page = await browser.newPage();
	}
	await page.setRequestInterception(true);
	await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36');
	if(custom_request) {
		page.on('request', custom_request)
	} else {
		page.on('request', req => {
			let requestUrl = req._url.split('?')[0].split('#')[0];
			if (
				blocked_rs.indexOf(req.resourceType()) !== -1 ||
				skipped_rs.some(resource => requestUrl.indexOf(resource) !== -1)
			) {
				req.abort();
			} else {
				req.continue();
			}
		});
	}
		
	try {
		res = await page.goto(url, {waitUntil: 'networkidle2', timeout: 0});
		if (res._status !== 200) {
			logg(`Error: ${res._status} ${url}`, true);
			return false;
		}
	} catch(e) {
		logg(`Error: Cant open ${url}`, true);
		return false;
	}
	return {page: page, browser:browser, url:url, res:res}
};

const _delay = () => new Promise(resolve => setTimeout(resolve, 1));
const to_key = (t) => t.toLowerCase().replace(/\s|[!"#$%&'()*+,-./:;<=>?@\[\]\^`{|}~]/g,'_');
const merge_array_object = (arr) => arr.reduce((obj, item) => (obj[Object.keys(item)[0].replace(/_+$/g,'')] = item[Object.keys(item)[0]], obj) ,{});
const find_difference = (a, b) => {
	let res = [], is_saved;
	if(a.length == 0) return b;
	for (let i = 0; i < a.length; i++) {
		is_saved = false;
 		for (let j = 0; j < b.length; j++) {
			if(a[i] == b[j]) is_saved = true;
		}
		if(!is_saved && a[i]) res.push(a[i]);
	}
	return res;
}

const is_accessable_url = (url) => {
	return new Promise(resolve => _https.get(url, res => {
	  if(res.statusCode == '200') return resolve(true)
	   return resolve(false)
	}).on('error', err => resolve(false)));
}

const source_list_write = async (table, data) => {
	try {
		let query = `INSERT INTO ${table}(url) VALUES('${data}')`;
		await do_query(query);
	} catch(err) {
		logg(err);
		return false;
	}
	console.log('saved '+data);
	return true;
};

const get_links = async (page, dom) => {
	let result;
	try {
		result = await page.evaluate((dom) => Array.from(
			document.querySelectorAll(dom), a => a.href
		), dom);
	} catch(e) {
		result = []
	}
	return result;
};

const create_source_table = async (key) => {
	let sql_table = key+'_source_list';
	let sql_progess_table = key+'_saved_list';
	await do_query(`
		CREATE TABLE IF NOT EXISTS ${sql_table}(id INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY, url VARCHAR(300));
		CREATE TABLE IF NOT EXISTS ${sql_progess_table}(id INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY, url VARCHAR(300));
		TRUNCATE TABLE ${sql_table};
	`);
	return sql_table;
}

const create_source_list = {
	gsmarena: async (source) => {
		let sql_table = await create_source_table(source.key);
		console.time('Done');
		let worker = await open_page(source.url);
		let nav = await get_links(worker.page, '.st-text a');
		if(nav.length == 0) {
			console.log('Navigation link not found')
			return false;
		}
		const push_link = async (browser, list, remain) => {
			console.log(`crawl ${list.length - remain + 1} / ${list.length} ... `);
			let worker = await open_page(list[remain - 1], browser);
			let items = await get_links(worker.page, '#review-body .makers > ul > li > a');
			items.map(item => source_list_write(sql_table, item));
			await worker.page.close();
			if(remain > 1) await push_link(browser, list, remain - 1)
			else return false;
		};
		const get_product_links = async (browser, list, arr, remain) => {
			console.log('parse '+list[remain - 1])
			let worker = await open_page(list[remain - 1], browser);
			let nav_links = await get_links(worker.page, '.review-nav .nav-pages > a');
			let items = await get_links(worker.page, '#review-body .makers > ul > li > a');
			items.map(item => source_list_write(sql_table, item));
			let array = arr.concat(nav_links);
			await worker.page.close();
			if(remain > 1) await get_product_links(browser, list, array, remain - 1)
			else {
				console.log(`Found ${array.length} pages. Start parse product page...`)
				await push_link(browser, array, array.length);
				return false;
			}
		};
		console.log(`Scouting.....`);
		await get_product_links(worker.browser, nav, [], nav.length);
		await worker.browser.close();
		console.timeEnd('Done');
	},
	geekbench: async (source) => {
		let sql_table = await create_source_table(source.key);
		console.time('Done');
		let push_link = async (link) => {
			if(await is_accessable_url(link)) source_list_write(sql_table, link);
			return false;
		};
		let childs = ['/android_devices/','/ios_devices/'];
		for (let link of childs) {
			let url = source.url+link;
			for (let i = 1; i < 1000; i+=5) {
				await Promise.all([
					push_link(url+i),
					push_link(url+parseInt(i+1)),
					push_link(url+parseInt(i+2)),
					push_link(url+parseInt(i+3)),
					push_link(url+parseInt(i+4))
				])
			}
		}
		console.timeEnd('Done');
	},
	productz: async (source) => {
		let sql_table = await create_source_table(source.key);
		console.time('Done');
		let worker = await open_page(test_url);
		if (worker === false) {
			console.log('System error....')
			return false;
		}
		const push_link = async (url, browser) => {
			console.log(url);
			let worker = await open_page(url, browser);
			let items = await get_links(worker.page, '.product-container a');
			items.map(item => source_list_write(sql_table, item));
			await worker.page.close();
		};
		for (let i = 1; i < 200; i+=5) {
			await Promise.all([
				push_link(source.url+i, worker.browser),
				push_link(source.url+parseInt(i+1), worker.browser),
				push_link(source.url+parseInt(i+2), worker.browser),
				push_link(source.url+parseInt(i+3), worker.browser),
				push_link(source.url+parseInt(i+4), worker.browser)
			])
		}
		await worker.browser.close();
		console.timeEnd('Done');
	},
	versus: async (source) => {
		let sql_table = await create_source_table(source.key);
		console.time('Done');
		let worker = await open_page(test_url);
		if (worker === false) {
			console.log('System error....')
			return false;
		}

		const get_product_list_from_api = async (browser, url, type, index) =>{
			let worker = await open_page(url+'/'+type, browser, interceptedRequest => {
		    interceptedRequest.continue({
		    	'url': 'https://versus.com/api/top/en/phone',
		      'method': 'POST',
		      'postData': JSON.stringify({filter:{}, page: index}),
		      'headers': { 
		      	"Origin": 'https://versus.com',
		      	"Content-Type": "application/json"
		      },
		    });
		  });
		  let res = await worker.res.text(), json;
			if(res) json = JSON.parse(res);
			await worker.page.close();
			if(!json.toplist) return false;
			if(json.toplist.length > 0) {
				return json.toplist.map(item => url+'/'+item.name_url);
			} else return false;
		}
		let loop = [...Array(100).keys()];
		for(let i of loop) {
			console.log('parse page: '+(i+1))
			let data = await get_product_list_from_api(worker.browser, source.url, 'phone', i+1);
			if(data) data.map(item => source_list_write(sql_table, item))
		}
		console.timeEnd('Done');
		await worker.browser.close();
	},
	phonearena: async (source) => {
		let sql_table = await create_source_table(source.key);
		console.time('Done');
		let worker = await open_page(source.url);
		if (worker === false) {
			console.log('System error....')
			return false;
		}
		let max_page = 0;
		try {
			max_page = await worker.page.evaluate((dom) => 
				document.querySelector(dom).getAttribute('data-page')
			, '.pagination.browse-pagination .pagination-control');
		} catch(e) {
			console.log('Page number not found '+url);
			logg('Error: Page number not found '+url+' '+e);
			return false;
		};
		if(max_page) {
			const push_link = async (url, browser) => {
				console.log(url);
				let worker = await open_page(url, browser);
				let links = await worker.page.evaluate((dom) =>
					Array.from(document.querySelectorAll(dom)).map(item => item.href)
				, '.stream-item .widget.widget-tilePhoneCard a');
				links.map(item => source_list_write(sql_table, item));
				await worker.page.close();
			};
			let loop = [...Array(parseInt(max_page)+1).keys()];
			for(let i of loop) await push_link(source.url+'/page/'+(i+1), worker.browser);
		}
			
		await worker.browser.close();
		console.timeEnd('Done');
	},
};

const crawl_init = async (url, sql_table) => {
	if (!url) {
		console.log('Product url not found')
		return false;
	}
	let obj = await open_page(url);
	try {
		await do_query(`CREATE TABLE IF NOT EXISTS ${sql_table}(id INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY) CHARACTER SET utf8mb4;`);
	} catch(err) {
		logg(`Error: CREATE TABLE ${sql_table}: ${err}`)
	}
	return obj;
};

const distribute_table = async (table, keys) => {
	if(!table) return false;
	let _table = table, table_part = [];
	try {
		table_part = await do_query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '${table}_p%';`);
	} catch(err) {
		logg(`Error: Check table part failed ${table}: ${err}`, true);
		return false
	}
	let max_table_part = table_part.map(i => i.table_name).join(' ').replace(/[a-z_]/g,'').split(' ').map(Number).sort(function(a, b){return a-b}).pop();
	if(max_table_part > 0) _table += '_p'+max_table_part;
	let res = await do_query(`SELECT COUNT(*) AS col FROM information_schema.columns WHERE table_name = '${_table}';`);
	let table_need = Math.ceil(keys.length / mysql_max_rows) - max_table_part;
	if(table_need) {
		let loop = [...Array(table_need-1).keys()];
		for(let i of loop) {
			try {
				await do_query(`CREATE TABLE IF NOT EXISTS ${table}_p${max_table_part+1}(id INT(11) UNSIGNED AUTO_INCREMENT PRIMARY KEY, parent_id INT(11)) CHARACTER SET utf8mb4;`);
			} catch(err) {
				logg(`Error: Create table failed ${table}_p${max_table_part+1}: ${err}`, true);
				return false;
			}
			table_part.push({table_name: `${table}_p${max_table_part+1}`});
		}
	}
	return {
		parts: [table,...table_part.map(i => i.table_name)],
		max: max_table_part,
		col: res[0].col
	}
}

const add_column_to_table = async (table, keys) => {
	if(!keys) return false;
	let query = '';
	for(let key of keys) query += `ADD COLUMN ${key} TEXT CHARACTER SET utf8mb4, `;
	try {
		await do_query(`ALTER TABLE ${table} ${query.slice(0,-2)};`);
	} catch(err) {
		logg(`Error: Add column failed ALTER TABLE ${table} ${query.slice(0,-2)}; ${err}`)
	};
	return true;
}

const insert_data_to_table = async (table, keys, values) => {
	if(!keys) return false;
	try {
		let insert = await do_query(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${values.join(',')})`);
		if(insert.insertId) return insert.insertId;
		return false;
	} catch(err) {
		console.log('Error: Insert values error, please read log')
		logg(`Error: Cant save values ${table} ${`VALUES (${values.join(',')})`}: ${err}`);
		return false;
	};
}

const get_columns_table = async (table) => {
	let list = [];
	try {
		list = await do_query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}';`);
	} catch(err) {
		logg(`Error: Get columns failed ${table}: ${err}`, true);
		return false
	}
	return list.map(i => i.column_name)
}

const save_data_to_mysql = async (table, columns, data) => {
	let keys = Object.keys(data), insert_stack = [], _keys = [];
	columns.map((c, i) => {
		let col = [], add = [];
		if(_keys.length == 0) _keys = c;
		col = [...new Set([..._keys,...keys])].slice(_keys.length, i*mysql_max_rows + mysql_max_rows);
		let keys_need_add = [...new Set([...c,...col])];
		if(i > 0) keys_need_add = keys_need_add.filter(x => !_keys.includes(x));
		let values_need_add = keys_need_add.map(k => `'${(data[k] || '').replace(/'/g,`\\'`)}'`);
		insert_stack.push({
			table: table.parts[i],
			keys: keys_need_add,
			add: keys_need_add.filter(x => !c.includes(x)),
			values: values_need_add
		});
		_keys = [...new Set([..._keys,...col])];
	})
	let is_parent = true, parent_id = null, is_done = true;
	for (let insert of insert_stack) {
		let add_column = await add_column_to_table(insert.table, insert.add);
		if(!is_parent) {
			insert.keys = ['parent_id',...insert.keys];
			insert.values = [parent_id,...insert.values];
		}
		let inserted = await insert_data_to_table(insert.table, insert.keys, insert.values);
		if(!inserted) {
			is_done = false;
			break;
		}
		if(is_parent && inserted) {
			parent_id = inserted;
			is_parent = false;
		} 
	}
	return is_done;
}

const crawl_save = async ({sql_db, sql_table, obj}) => {
	let id = Math.random().toString(36).substring(7);
	console.time('Saved '+id);
	let table = await distribute_table(sql_table, Object.keys(obj)), columns = [];
	for(let t of table.parts) {
		let col = await get_columns_table(t);
		columns.push(col.filter(v => (v !== 'id' && v !== 'parent_id')));
	}
	let saved = await save_data_to_mysql(table, columns, obj);
	if(!saved) return false;
	try {
		await do_query(`INSERT INTO ${sql_table}_saved_list(url) VALUES ('${obj.src_url}')`);
	} catch(err) {
		console.log('Error: Saved list insert error, please read log')
		logg(`Error: Cant save values ${obj.src_url}: ${err}`)
	};
	console.timeEnd('Saved '+id);
};

const crawl_resume = async (target) => {
	console.log('Resume from saved point...');
	let source_list = [], saved_list = [];
	try {
		source_list = await do_query(`SELECT url FROM ${target}_source_list;`);
		source_list = source_list.map(item => item.url)
	} catch(err) {
		console.log(`Error: Cant read data from ${target}_source_list`);
		logg(`Error: Cant read data from ${target}_source_list: ${err}`);
		return false;
	}
	try {
		saved_list = await do_query(`SELECT url FROM ${target}_saved_list;`);
		saved_list = saved_list.map(item => item.url)
	} catch(err) {
		console.log(`Error: Cant read data from ${target}_saved_list`);
		logg(`Error: Cant read data from ${target}_saved_list: ${err}`);
		return false;
	}
	if (saved_list == []) return source_list;
	source_list = [...new Set(source_list)];
	saved_list = [...new Set(saved_list)];
	let res = source_list.filter(x => !saved_list.includes(x));
	console.log(`Found ${res.length} difference from source`);
	return res
};

const crawl_parallel = async (list=[], key) => {
	if(!list) {
		console.log('Crawl list is empty');
		return false;
	}
	console.log('Prepare....')
	let obj = await crawl_init(test_url, key)
	if (obj === false) {
		console.log('System error....')
		return false;
	}
	console.log('Crawling....')
	console.time('Done');
	let length = list.length;
	for (let i = 0; i < length; i+=5) {
		console.time('Total');
		await Promise.all([
			crawl[key](list[i], obj.browser),
			crawl[key](list[i+1], obj.browser),
			crawl[key](list[i+2], obj.browser),
			crawl[key](list[i+3], obj.browser),
			crawl[key](list[i+4], obj.browser),
		]);
		console.timeEnd('Total');
		console.log(`Progress: ${i+5}/${length}`);
	}
	await obj.browser.close();
	console.timeEnd('Done');
};

const crawl_stack = async (list=[], key) => {
	if(!list) {
		console.log('Crawl list is empty');
		return false;
	}
	console.log('Prepare....')
	let obj = await crawl_init(test_url, key)
	if (obj === false) {
		console.log('System error....')
		return false;
	}
	console.log('Crawling....')
	console.time('Done');
	let length = list.length, count = 1;
	for(const product of list) {
	 	console.time('Total');
	 	await crawl[key](product, obj.browser)
	 	console.timeEnd('Total');
	 	console.log(`Progress: ${count}/${length}`);
	 	count++;
	}
	await obj.browser.close();
	console.timeEnd('Done');
};

const crawl = {
	gsmarena: async (url, browser) => {
		let worker = await open_page(url, browser);
		if (worker === false) return false;
		console.log(url);

		let data = {}, info = {};
		try {
			info = await worker.page.evaluate((dom) => 
				Array.from(document.querySelectorAll(dom)).map(item => {
					let title = item.textContent;
					let $tbody = item.parentNode.parentNode;
					let sub_title = Array.from($tbody.querySelectorAll('.ttl')).map(item => item.textContent);
					let content = Array.from($tbody.querySelectorAll('.nfo')).map(item => item.textContent);
					let text_to_key = (t) => t.toLowerCase().replace(/\s|[!"#$%&'()*+,-./:;<=>?@\[\]\^`{|}~]/g,'_');
					let result = {};
					for (let i = 0; i < sub_title.length; i++) {
						if (sub_title[i].length == 1) {
							if (i-1 < 0) {
								result[text_to_key(`${title}`)] = content[i].trim()
							} else result[text_to_key(`${title}_${sub_title[i-1]}`)] += ' '+content[i].trim()
						} else {
							result[text_to_key(`${title}_${sub_title[i]}`)] = content[i].trim()
						}
					}
					return result
				})
			, '#specs-list table tr > th');
		} catch(e) {
			console.log('Broken link'+url);
			logg('Error: broken link '+url+' '+e);
		};
		data.img_url = await worker.page.evaluate((dom) => 
			document.querySelector(dom).src
		, '.specs-photo-main img');
		data.model = await worker.page.evaluate((dom) => 
			document.querySelector(dom).textContent
		, '.specs-phone-name-title');
		data.src_url = url;
		data.product_id = "";
		let modelname = data.model.split(' ');
		data.brand = modelname[0];
		if(modelname.length > 1) modelname.shift();
		data.model = modelname.join(' ');

		if(Array.isArray(info)) {
			data = {...data,...merge_array_object(info)};
			await crawl_save({sql_db: 'dataspot', sql_table: 'gsmarena', obj: data});
		}
		
		await worker.page.close();
	},
	geekbench: async (url, browser) => {
		let worker = await open_page(url, browser);
		if (worker === false) return false;
		console.log(url);

		const data = {src_url: url};
		var key_array = [] , data_array = [];
		try {
			data.model = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent
			, '.system-information tr:nth-child(1) .value');

			data.cpu = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent
			, '.system-information tr:nth-child(3) .value');

			data.cpu_frequency = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent
			, '.system-information tr:nth-child(4) .value');

			data.cpu_core = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent
			, '.system-information tr:nth-child(5) .value');

			key_array = await worker.page.evaluate((dom) => {
				let text_to_key = (t) => t.toLowerCase().replace(/\s|[!"#$%&'()*+,-./:;<=>?@\[\]\^`{|}~]/g,'_');
				return Array.from(document.querySelectorAll(dom)).map(item => text_to_key(item.textContent))
			}, '.benchmark-box-wrapper .description');
			data_array = await worker.page.evaluate((dom) => 
				Array.from(document.querySelectorAll(dom)).map(item => item.textContent.trim())
			, '.benchmark-box-wrapper .score');
		} catch(e) {
			console.log('Broken link'+url);
			logg('Error: broken link '+url+' '+e);
		};
		if (key_array.length != data_array.length) logg('Error: Data mapping incorrect '+url);
		for (let i = 0; i < key_array.length; i++) data[key_array[i]] = data_array[i] || '';

		let modelname = data.model.split(' ');
		let device = url.split('com/')[1].split('_')[0];
		data.brand = modelname[0];
		data.device = device;
		if(device == 'ios') data.brand = 'Apple';
		if(modelname.length > 1 && device != 'ios') modelname.shift();
		data.model = modelname.join(' ');
		await crawl_save({sql_db: 'dataspot', sql_table: 'geekbench', obj: data});
		await worker.page.close();
	},
	productz: async (url, browser) => {
		let worker = await open_page(url, browser);
		if (worker === false) return false;
		console.log(url);

		const data = {model:"", src_url: url};
		var key_array = [] , data_array = [];
		try {
			data.model = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent
			, 'h1.title');
			data.img_url = await worker.page.evaluate((dom) => 
				document.querySelector(dom).getAttribute('data-src')
			, '.image-preview > figure > img');
			key_array = await worker.page.evaluate((dom) => {
				let text_to_key = (t) => t.toLowerCase().replace(/\s|[!"#$%&'()*+,-./:;<=>?@\[\]\^`{|}~]/g,'_');
				return Array.from(document.querySelectorAll(dom)).map(item => text_to_key(item.textContent))
			}, '.is-product-spec th > label');
			data_array = await worker.page.evaluate((dom) => 
				Array.from(document.querySelectorAll(dom)).map(item => {
					let text = item.textContent;
					if (text.length == 0) text = item.children[0].getAttribute('data-tooltip');
					return text;
				})
			, '.is-product-spec td');
		} catch(e) {
			console.log('Broken link'+url);
			logg('Error: broken link '+url+' '+e);
		};
		
		if (key_array.length != data_array.length) logg('Error: Data mapping incorrect '+url);
		for (let i = 0; i < key_array.length; i++) data[key_array[i]] = data_array[i] || '';
		let modelname = data.model.split(' ');
		data.brand = modelname[0];
		if(modelname.length > 1) modelname.shift();
		data.model = modelname.join(' ');
		await crawl_save({sql_db: 'dataspot', sql_table: 'productz', obj: data});
		await worker.page.close();
	},
	versus: async (url, browser) => {
		let worker = await open_page(url, browser);
		if (worker === false) return false;
		console.log(url);
		const regex = /<script>window\.__data=(.*}}})<\/script>/gm;
		let raw = await worker.res.text();
		let get_data = regex.exec(raw);
		if(!get_data) {
			console.log('Broken link'+url);
			logg('Error: broken link '+url);
			return false;
		}
		let result = JSON.parse(get_data[1]), data = {};
		let info = result.comparison.rivals[0];
		let specs = result.comparison.propGroups;

		let modelname = info.name.split(' ');
		data.brand = modelname[0];
		if(modelname.length > 1) modelname.shift();
		data.model = modelname.join(' ');
		data.img_url = 'https://dzpbctl0ygela.cloudfront.net'+info.picture.raw;
		data.src_url = url
		for(let group of specs) {
			for(let spec of group.reasons) {
				data[spec.name] = (spec.values.toString()+(spec.unit ? spec.unit : '')).trim();
			}
		}
		await crawl_save({sql_db: 'dataspot', sql_table: 'versus', obj: data});
		await worker.page.close();
	},
	phonearena: async (url, browser) => {
		let worker = await open_page(url, browser);
		if (worker === false) return false;
		console.log(url);

		let data = {model:'', src_url: url}, info = {};
		try {
			info = await worker.page.evaluate((dom) => {
				let text_to_key = (t) => t.toLowerCase().replace(/\s|[!"#$%&'()*+,-./:;<=>?@\[\]\^`{|}~]/g,'_');
				let _trim = (t) => t.textContent.trim().replace(/:/g,'');
				return Array.from(document.querySelectorAll(dom)).map(block =>
					Array.from(block.children).map(f1 => {
						return Array.from(f1.querySelectorAll('.media-header')).map(f2 => {
							let first_title = text_to_key(_trim(f2.querySelector('h3')));
							let first_value = _trim(f2.querySelector('.media-body > span'));
							let titles = Array.from(f2.parentNode.querySelectorAll('h3'));
							let values = Array.from(f2.parentNode.querySelectorAll('.media-body')).map(i => _trim(i.lastChild));
							if (titles.length == 1) return JSON.parse(`{"${first_title}": "${first_value.replace(/"/g,'\\"')}" }`);
							titles.shift();
							values.shift()
							return titles.map((sub, i) => JSON.parse(`{
								"${first_title}_${text_to_key(_trim(sub))}": "${values[i].replace(/"/g,'\\"')}"
							}`))
						})
					}).flat(3)
				).flat(3)
			}, '.specs-table');
			data.model = await worker.page.evaluate((dom) => 
				document.querySelector(dom).textContent.trim()
			, '.phone-name h1');

		} catch(e) {
			console.log('Broken link'+url);
			logg('Error: broken link '+url+' '+e);
		};
		let modelname = data.model.split(' ');
		data.brand = modelname[0];
		if(modelname.length > 1) modelname.shift();
		data.model = modelname.join(' ');
		if(Array.isArray(info)) {
			data = {...data,...merge_array_object(info)};
			await crawl_save({sql_db: 'dataspot', sql_table: 'phonearena', obj: data});
		}
		await worker.page.close();
	},
};


(async () => {
	const targets = [
		{
			'url': 'https://www.gsmarena.com/makers.php3',
			'key': 'gsmarena'
		},
		{
			'url': 'https://browser.geekbench.com',
			'key': 'geekbench'
		},
		{
			'url': 'https://productz.com/en/mobile-phones/',
			'key': 'productz'
		},
		{
			'url': 'https://versus.com/en',
			'key': 'versus'
		},
		{
			'url': 'https://www.phonearena.com/phones',
			'key': 'phonearena'
		}
	];
	let params = process.argv;
	let index = null;
	if(params[2] == 'gsmarena') index = 0;
	if(params[2] == 'geekbench') index = 1;
	if(params[2] == 'productz') index = 2;
	if(params[2] == 'versus') index = 3;
	if(params[2] == 'phonearena') index = 4;

	if(index !== null) {
		if(!params[3]) throw Error ('Need parameter 3 point to function')
		if(params[3] == 'init') 
			await create_source_list[targets[index].key](targets[index]);
		if(params[3] == 'crawl') {
			if(params[4] == 'parallel') {
				await crawl_parallel(await crawl_resume(targets[index].key), targets[index].key);
			} else {
				await crawl_stack(await crawl_resume(targets[index].key), targets[index].key);
			}
		}
	} else throw Error ('Need parameter 2 point to source name');

	return false;
})();
