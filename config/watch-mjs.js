// Watch dist/*.module.js files and mirror them to *.mjs so that Node 13
// "exports.import" resolution keeps working during `microbundle watch`
// (which only writes .module.js and never re-runs the postbuild step).
// Intended to be launched in parallel with `microbundle watch -f esm`.
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const subRepositories = [
	'compat',
	'debug',
	'devtools',
	'hooks',
	'jsx-runtime',
	'test-utils'
];
const snakeCaseToCamelCase = str =>
	str.replace(/([-_][a-z])/g, group => group.toUpperCase().replace('-', ''));

const targets = [
	{ dir: path.join(cwd, 'dist'), name: 'preact' },
	...subRepositories.map(name => ({
		dir: path.join(cwd, name, 'dist'),
		name: name.includes('-') ? snakeCaseToCamelCase(name) : name
	}))
];

const copyOnce = ({ dir, name }) => {
	const srcPath = path.join(dir, `${name}.module.js`);
	const dstPath = path.join(dir, `${name}.mjs`);
	try {
		fs.writeFileSync(dstPath, fs.readFileSync(srcPath));
		const stamp = new Date().toLocaleTimeString();
		console.log(`[watch-mjs ${stamp}] ${path.relative(cwd, srcPath)} -> ${name}.mjs`);
	} catch (e) {
		if (e.code !== 'ENOENT') console.error(`[watch-mjs] ${srcPath}:`, e.message);
	}
};

// Initial copy so .mjs exists even before the first microbundle rebuild.
targets.forEach(copyOnce);

for (const t of targets) {
	if (!fs.existsSync(t.dir)) continue;
	fs.watch(t.dir, (_event, filename) => {
		if (filename === `${t.name}.module.js`) copyOnce(t);
	});
}

console.log('[watch-mjs] watching', targets.map(t => path.relative(cwd, t.dir)).join(', '));
