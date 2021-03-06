'use strict';
const childProcess = require('child_process');
const util = require('util');
const crossSpawn = require('cross-spawn');
const stripEof = require('strip-eof');
const npmRunPath = require('npm-run-path');
const isStream = require('is-stream');
const _getStream = require('get-stream');
const onExit = require('signal-exit');
const errname = require('./lib/errname');

const TEN_MEGABYTES = 1000 * 1000 * 10;

function handleArgs(cmd, args, opts) {
	let parsed;

	if (opts && opts.__winShell === true) {
		delete opts.__winShell;
		parsed = {
			command: cmd,
			args,
			options: opts,
			file: cmd,
			original: cmd
		};
	} else {
		parsed = crossSpawn._parse(cmd, args, opts);
	}

	opts = Object.assign({
		maxBuffer: TEN_MEGABYTES,
		stripEof: true,
		preferLocal: true,
		encoding: 'utf8',
		reject: true,
		cleanup: true
	}, parsed.options);

	if (opts.preferLocal) {
		opts.env = npmRunPath.env(opts);
	}

	return {
		cmd: parsed.command,
		args: parsed.args,
		opts
	};
}

function handleInput(spawned, opts) {
	const input = opts.input;

	if (input === null || input === undefined) {
		return;
	}

	if (isStream(input)) {
		input.pipe(spawned.stdin);
	} else {
		spawned.stdin.end(input);
	}
}

function handleOutput(opts, val) {
	if (val && opts.stripEof) {
		val = stripEof(val);
	}

	return val;
}

function handleShell(fn, cmd, opts) {
	let file = '/bin/sh';
	let args = ['-c', cmd];

	opts = Object.assign({}, opts);

	if (process.platform === 'win32') {
		opts.__winShell = true;
		file = process.env.comspec || 'cmd.exe';
		args = ['/s', '/c', `"${cmd}"`];
		opts.windowsVerbatimArguments = true;
	}

	if (opts.shell) {
		file = opts.shell;
		delete opts.shell;
	}

	return fn(file, args, opts);
}

function getStream(process, stream, encoding, maxBuffer) {
	if (!process[stream]) {
		return null;
	}

	let ret;

	if (encoding) {
		ret = _getStream(process[stream], {
			encoding,
			maxBuffer
		});
	} else {
		ret = _getStream.buffer(process[stream], {maxBuffer});
	}

	return ret.catch(err => {
		err.stream = stream;
		err.message = `${stream} ${err.message}`;
		throw err;
	});
}

const processDone = spawned => new Promise(resolve => {
	spawned.on('exit', (code, signal) => {
		resolve({code, signal});
	});

	spawned.on('error', err => {
		resolve({err});
	});
});

module.exports = jest.fn((cmd, args, opts) => {
	let joinedCmd = cmd;

	if (Array.isArray(args) && args.length > 0) {
		joinedCmd += ' ' + args.join(' ');
	}

	cmd = getMockCommand();

	const parsed = handleArgs(cmd, args, opts);
	const encoding = parsed.opts.encoding;
	const maxBuffer = parsed.opts.maxBuffer;

	let spawned;
	try {
		spawned = childProcess.exec(parsed.cmd, parsed.opts);
	} catch (err) {
		return Promise.reject(err);
	}

	let removeExitHandler;
	if (parsed.opts.cleanup) {
		removeExitHandler = onExit(() => {
			spawned.kill();
		});
	}

	const promise = Promise.all([
		processDone(spawned),
		getStream(spawned, 'stdout', encoding, maxBuffer),
		getStream(spawned, 'stderr', encoding, maxBuffer)
	]).then(arr => {
		const result = arr[0];
		const stdout = arr[1];
		const stderr = arr[2];

		let err = result.err;
		const code = result.code;
		const signal = result.signal;

		if (removeExitHandler) {
			removeExitHandler();
		}

		if (err || code !== 0 || signal !== null) {
			if (!err) {
				err = new Error(`Command failed: ${joinedCmd}\n${stderr}${stdout}`);
				err.code = code < 0 ? errname(code) : code;
			}

			// TODO: missing some timeout logic for killed
			// https://github.com/nodejs/node/blob/master/lib/child_process.js#L203
			// err.killed = spawned.killed || killed;
			err.killed = err.killed || spawned.killed;

			err.stdout = stdout;
			err.stderr = stderr;
			err.failed = true;
			err.signal = signal || null;
			err.cmd = joinedCmd;

			if (!parsed.opts.reject) {
				return err;
			}

			throw err;
		}

		return {
			stdout: handleOutput(parsed.opts, stdout),
			stderr: handleOutput(parsed.opts, stderr),
			code: 0,
			failed: false,
			killed: false,
			signal: null,
			cmd: joinedCmd
		};
	});

	crossSpawn._enoent.hookChildProcess(spawned, parsed);

	handleInput(spawned, parsed.opts);

	spawned.then = promise.then.bind(promise);
	spawned.catch = promise.catch.bind(promise);

	return spawned;
});

module.exports.stdout = jest.fn(function () {
	// TODO: set `stderr: 'ignore'` when that option is implemented
	return module.exports.apply(null, arguments).then(x => x.stdout);
});

module.exports.stderr = jest.fn(function () {
	// TODO: set `stdout: 'ignore'` when that option is implemented
	return module.exports.apply(null, arguments).then(x => x.stderr);
});

module.exports.shell = jest.fn((cmd, opts) => handleShell(module.exports, cmd, opts));

module.exports.sync = jest.fn((cmd, args, opts) => {
	cmd = getMockCommand();
	const parsed = handleArgs(cmd, args, opts);

	if (isStream(parsed.opts.input)) {
		throw new TypeError('The `input` option cannot be a stream in sync mode');
	}

	const result = childProcess.exec(parsed.cmd, parsed.opts);

	result.stdout = handleOutput(parsed.opts, result.stdout);
	result.stderr = handleOutput(parsed.opts, result.stderr);

	return result;
});

module.exports.shellSync = jest.fn((cmd, opts) => handleShell(module.exports.sync, cmd, opts));

module.exports.spawn = jest.fn(util.deprecate(module.exports, 'execa.spawn() is deprecated. Use execa() instead.'));

let mockResults = [];

module.exports.__setMockResults = (results) => {
	results = results || [];

	mockResults = results.map((result) => {
		let stdout = '';
		let stderr = '';
		let code = 0;

		if (typeof result === 'string') {
			stdout = result;
		}
		else if (Array.isArray(result)) {
			stdout = result[0];
			stderr = (typeof result[1] === 'number' ? '' : result[1]);
			code = (typeof result[1] === 'number' ? result[1] : result[2]);
		}
		else {
			return result;
		}

		return { stdout, stderr, code };
	})
}

jasmine.getEnv().addReporter({
  specStarted: () => (mockResults = []),
});

const getMockCommand = () => {
	const { stdout = '', stderr = '', code = 0 } = mockResults.shift() || {};
	return `echo "${stdout.replace('"', '\\"')}"; (>&2 echo ${stderr.replace('"', '\\"')}); exit ${code};`;
}
