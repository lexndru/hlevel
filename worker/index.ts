// Copyright (c) 2022 Alexandru Catrina <alex@codeissues.net>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { Readable } from 'stream';
import { spawn } from 'child_process';
import fetch, { Response } from 'node-fetch';
import AbortController, { AbortSignal } from 'abort-controller';
import { accept, AsyncTask, Ticket } from '..';

type Worker = (t: Ticket) => void | Promise<void>;

const workers: Map<Worker, string[]> = new Map();

export function register(worker: Worker, pattern: string, ...otherPatterns: string[]) {
	const triggers = [pattern, ...otherPatterns];
	workers.set(worker, triggers);

	console.log(`* ${worker.name} available for: ${triggers.join(`, `)}`);
}

export default function () {
	register(HttpWorker, `http`, `https`);
	register(FileWorker, `file`, `pipe`);

	workers.forEach((patterns, worker) => {
		patterns.map(a => accept(a, worker));
	});
}

function log(text: string, session: string) {
	console.log(
		'\x1b[2m%s\x1b[0m \x1b[1m%s\x1b[0m \x1b[32m%s\x1b[0m',
		new Date().toISOString(), session, text);
}

interface HttpOptions {
	readonly HttpTimeout?: number;
	readonly HttpHeaders?: Record<string, string>;
	readonly HttpMethod?: "HEAD" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	readonly HttpSchema?: string;
}

const DEFAULT_HTTP_TIMEOUT = 30; // seconds
const DEFAULT_HTTP_METHOD = `GET`;

async function HttpWorker(ticket: Ticket) {
	const options = JSON.parse(ticket.task.options) as HttpOptions;
	const timeout = (options?.HttpTimeout || DEFAULT_HTTP_TIMEOUT) * 1000;
	const headers = options?.HttpHeaders || {};
	const method = options?.HttpMethod || DEFAULT_HTTP_METHOD;

	if (ticket.isAsync) headers['location'] = (ticket.task as AsyncTask).async;

	const ctrl = new AbortController();
	const tout = setTimeout(() => ctrl.abort(), timeout);

	log(`[http] fetching requirements for "${ticket.task.comment}"`, ticket.task.session);

	try {
		const response: Response = await fetch(ticket.task.action, {
			headers,
			method,
			signal: ctrl.signal,
			body: ["GET", "HEAD"].includes(method.toUpperCase())
				? undefined
				: ticket.task.payload === null ? undefined : Buffer.from(ticket.task.payload, `base64`)
		});

		log(`[http] processing response from "${ticket.task.action}"`, ticket.task.session);

		if (response.ok) {
			if (ticket.isAsync) {
				ticket.wait(`waiting async callback from "${ticket.task.action}", reply is ${response.status}`);
				log(`[http] ticket is on wait, reply is ${response.statusText}`, ticket.task.session);
			} else {
				const buf = response.body.read();
				if (buf instanceof Buffer) {
					ticket.update(buf);
					log(`[http] updating ticket with buffer response`, ticket.task.session);
				} else if (buf) {
					ticket.update(Buffer.from(buf));
					log(`[http] updating ticket with response`, ticket.task.session);
				}
				ticket.done();
				log(`[http] ticket is done`, ticket.task.session);
			}
		} else {
			ticket.fail(`got ${response.status} ${response.statusText} from "${ticket.task.action}" on ${method}`);
			log(`[http] ticket is blocked, got ${response.statusText} from "${ticket.task.action}" ...`, ticket.task.session);
		}
	} catch (e) {
		if (e instanceof AbortSignal) {
			ticket.fail(`http call to "${ticket.task.action}" timeout after ${timeout} seconds`);
			log(`[http] timeout after ${timeout} seconds, ticked is halted now`, ticket.task.session);
		} else {
			ticket.fail(`error: ${(e as Error).message}`);
			log(`[http] error "${(e as Error).message}", ticked is halted now`, ticket.task.session);
		}
	} finally {
		clearTimeout(tout);
	}

	log(`[http] worker is now idle`, ticket.task.session);
}

async function FileWorker(ticket: Ticket) {
	const file = ticket.task.action.replace(`file://`, ``);
	const proc = spawn(file);

	log(`[file] running ${file}`, ticket.task.session);

	const data = Buffer.from(ticket.task.payload, `base64`);
	Readable.from(data).pipe(proc.stdin);

	proc.stdin.on(`error`, err => {
		ticket.fail(`perhaps file does not accept data? ${err.message}`);

		log(`[file] worker is now idle after stdin error`, ticket.task.session);
	});

	proc.on(`close`, code => {
		if (code === null) {
			log(`[file] unexpected close`, ticket.task.session);
		} else if (code > 0) {
			const err = proc.stderr.read();
			if (err) ticket.fail(err);

			log(`[file] error code ${code}`, ticket.task.session);
		} else {
			const out = proc.stdout.read();
			if (out) ticket.update(out);
			ticket.done();

			log(`[file] ticket is done`, ticket.task.session);
		}

		log(`[file] worker is now idle`, ticket.task.session);
	});

	proc.on(`error`, err => {
		ticket.fail(err.message);

		log(`[file] failed to resolve ticket because: ${err.message}`, ticket.task.session);
		log(`[file] worker is now idle after error`, ticket.task.session);
	});
}