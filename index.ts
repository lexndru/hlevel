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

import { basename } from 'path';
import { Readable } from 'stream';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import jwt from 'jsonwebtoken';
import fetch, { Response } from 'node-fetch';
import abortController, { AbortSignal } from 'abort-controller';
import { version, homepage } from './package.json';

const AUTH = String(process.env.AUTH);
const HOST = String(process.env.HOST);
const PORT = Number(process.env.PORT);

function guard(authorization?: string) {
	return new Promise(async (resolve, reject) => {
		if (AUTH) {
			jwt.verify(authorization as string, AUTH, err => {
				err ? reject(err) : resolve(true);
			});
		} else {
			resolve(true);
		}
	});
}

type HTTPVerbs = "HEAD" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

enum Trigger {
	JOIN = `#join`,
	TASK = `#task`,
	QUIT = `#quit`,
}

const SESSION_LEN = 18;

const IS_VERBOSE = process.env.IS_VERBOSE === "true";
const IS_DEBUG = process.env.IS_DEBUG === "true";

// ********************************** logging **********************************

function __Log(format: string, text: string, session?: string) {
	console.log(format, new Date().toISOString(), session ? session + ` ` : ``, text);
}

function system(text: string) {
	if (IS_DEBUG) {
		__Log('\x1b[2m%s\x1b[0m $ \x1b[2m%s\x1b[0m\x1b[2m%s\x1b[0m', text, ``.padStart(SESSION_LEN, `.`))
	}
}

function verbose(text: string, session?: string) {
	if (IS_VERBOSE) {
		__Log('\x1b[2m%s\x1b[0m v \x1b[2m%s\x1b[0m\x1b[2m%s\x1b[0m', text, session)
	}
}

function info(text: string, session?: string) {
	__Log('\x1b[2m%s\x1b[0m i \x1b[1m%s\x1b[0m\x1b[1m%s\x1b[0m', text, session);
}

function warn(text: string, session?: string) {
	__Log('\x1b[2m%s\x1b[0m ! \x1b[31m%s\x1b[0m\x1b[31m%s\x1b[0m', text, session);
}

// ********************************* pipe utils ********************************

type __pipe__ = [boolean, NodeJS.ReadableStream | null];

interface __args {
	readonly session: string;
	readonly address: string;
	readonly payload: NodeJS.ReadableStream | null;
}

function __bash__(): __pipe__ {
	throw new Error(`must be implemented`);
}

interface __HttpArguments extends __args {
	readonly headers: Record<string, string>;
	readonly timeout: number;
	readonly method: HTTPVerbs;
}

async function __http__({ session, address, payload, method, headers, timeout }: __HttpArguments): Promise<__pipe__> {
	const ctrl = new abortController();
	const tout = setTimeout(() => ctrl.abort(), timeout * 1000);

	try {
		const response: Response = await fetch(address, {
			headers,
			method,
			signal: ctrl.signal,
			body: ["GET", "HEAD"].includes(method.toUpperCase())
				? undefined
				: payload === null ? undefined : payload
		});

		return [response.ok, response.body];
	} catch (e) {
		if (e instanceof AbortSignal) {
			warn(`http call to "${address}" timeout after ${timeout} seconds`, session);
		} else {
			warn(`error! ${(e as Error).message}`, session);
		}
	} finally {
		clearTimeout(tout);
	}

	return [false, null];
}

function __unix__(): __pipe__ {
	throw new Error(`must be implemented`);
}

// ********************************* flow utils ********************************

interface Step {
	readonly AsyncCall: string;
	readonly Call: string;
	readonly Comment: string;
	readonly Channel: string;
	readonly HttpHeaders: Record<string, string>;
	readonly HttpTimeout: number;
	readonly HttpVerb: HTTPVerbs;
	readonly Then: Step | null;
}

const DefaultStep: Step = {
	AsyncCall: ``, 		// path to async script or address of async service
	Call: ``, 			// path to script or address of service
	Comment: ``, 		// optional comment for user to understand current step
	Channel: ``, 		// channel name; mandatory then trigger is set to #message
	HttpHeaders: {},	// optional http headers; used only for http callables
	HttpTimeout: 60, 	// seconds; non-positive numbers are not allowed
	HttpVerb: `PATCH`,
	Then: null,			// optional next *step* to invoke
};

interface PathSession {
	readonly path: Path;
	readonly step: Step | null;
	readonly level: number;
	readonly socket: WebSocket;
	readonly session: string;
	readonly payload: NodeJS.ReadableStream | null;
}

async function next(ps: PathSession) {
	if (ps.step === null) {
		ps.path.clean(ps);
		return;
	}

	const {
		AsyncCall,
		Call,
		HttpHeaders,
		HttpTimeout,
		HttpVerb,
		Then,
	} = ps.step;

	Path.log(ps);

	const isAsync = !!AsyncCall;
	const address = isAsync ? AsyncCall : Call;

	if (isAsync) {
		const pendingId = uuidv4();
		Path.pause(ps, pendingId);
	}

	const callback = ([isSuccessful, newPayload]: __pipe__) => {
		if (isAsync) {
			verbose(`[${ps.level}/${ps.path.absHeight}] done; ok? ${isSuccessful}; next is async`, ps.session);
		} else if (isSuccessful) {
			verbose(`[${ps.level}/${ps.path.absHeight}] done; ok? ${isSuccessful}; next? ${!!Then}`, ps.session);
			next({ ...ps, step: Then, payload: newPayload, level: ps.level + 1 });
		} else {
			verbose(`[${ps.level}/${ps.path.absHeight}] done; err or failed`, ps.session);
		}
	};

	switch ((address.split(`://`).shift() as string || ``).toLocaleLowerCase()) {
		case "bash":
			__bash__();
			break;
		case "https":
		case "http":
			__http__({
				...ps, address, method: HttpVerb, headers: HttpHeaders, timeout: HttpTimeout
			}).then(callback);
			break;
		case "unix":
			__unix__();
			break;
	}
}

class Path {
	public static readonly Pendings: Map<string, [Date, PathSession]> = new Map();

	public readonly firstStep: Step;
	public readonly absHeight: number;

	public constructor(firstStep: Step) {
		this.firstStep = firstStep;
		this.absHeight = Path.calculateHeight(firstStep);
	}

	public static calculateHeight(step: Step) {
		let height = 1;
		let currentStep = step.Then;

		while (currentStep) {
			height++;
			currentStep = currentStep.Then;
		}

		return height;
	}

	public static pause(ps: PathSession, id: string) {
		const { path, step, session, level } = ps;

		verbose(`[${level}/${path.absHeight}] on pause after this step; pending ID is "${id}", will resume later`, session);

		if (step) {
			step.HttpHeaders['location'] = `${HOST}:${PORT}/_resume/${id}`;
		}

		Path.Pendings.set(id, [new Date(), ps]);
	}

	public static resume(id: string, newPayload?: NodeJS.ReadableStream) {
		const ps = Path.Pendings.get(id);

		if (ps === undefined) {
			warn(`got a request to resume a missing ID ${id}; is this spam?`);
			return;
		}

		Path.Pendings.delete(id);
		const [pausedAt, { path, level, session, step }] = ps;

		verbose(`[${level}/${path.absHeight}] resuming pending ID "${id}"`, session);
		verbose(`[${level}/${path.absHeight}] initially paused at ${pausedAt.toISOString()}`, session);

		next({ ...ps[1], step: step?.Then || null, payload: newPayload || null, level: level + 1 });
	}

	public static log({ step, session, level, path }: PathSession) {
		if (step?.Comment) {
			info(`[${level}/${path.absHeight}] running: ${step.Comment} ...`, session);
		} else {
			info(`[${level}/${path.absHeight}] running ...`, session);
		}
	}

	public start(session: string, socket: WebSocket, payload?: NodeJS.ReadableStream) {
		verbose(`[0/${this.absHeight}] starting, first step is "${this.firstStep.Comment}" ...`, session);

		next({
			path: this,
			step: this.firstStep,
			level: 1,
			socket,
			session,
			payload: payload || null
		});
	}

	public clean({ socket, payload, session }: PathSession) {
		let buf: Buffer = Buffer.alloc(0);

		if (payload !== null) {
			const maybeBuff = payload.read();
			if (maybeBuff !== null) {
				buf = maybeBuff instanceof Buffer ? maybeBuff : Buffer.from(maybeBuff);
			}
		}

		info(`[${this.absHeight}/${this.absHeight}] finish; package has ${buf.length / 1024} KB`, session);

		if (socket.readyState === socket.OPEN) {
			socket.send(buf);
			system(`succesfully sent package to socket ...`);
		} else {
			system(`socket is closed, cannot send package ...`);
		}

		system(`cleaning session "${session}" ...`);
	}
}

class Flow {
	public readonly title: string;
	public readonly paths: Path[];
	public readonly event: string;
	public readonly inbox: string;

	public constructor(title: string, paths: Step[]) {
		this.title = title;
		this.paths = paths.map(a => new Path(a));
		this.event = title.split(` `).filter(a => a.length > 1 && a.charAt(0) === `#`).pop() as string;

		try {
			const task = this.event.indexOf(`.`);
			this.inbox = task > -1 ? this.event.slice(task) : ``;
		} catch (e) {
			throw new Error(`incorrect trigger on flow "${title}" because: ${(e as Error).message}`);
		}
	}

	public run(socket: WebSocket, buffer?: Buffer) {
		const session = `0x` + randomBytes(8).toString(`hex`);

		system(`creating new session "${session}" ...`);
		verbose(`[#/#] ready to start "${this.title}" with ${(buffer?.length || 0) / 1024} KB ...`, session);

		this.paths.map(a => a.start(session, socket, buffer ? Readable.from(buffer) : undefined));
	}

	public probe(evName: string, buffer?: Buffer): [boolean, Buffer?] {
		if (this.event.startsWith(evName)) {
			if (buffer && this.inbox.length > 0) {
				const j = this.inbox.length;

				return [
					buffer.slice(0, j).toString() === this.inbox,
					buffer.slice(j)
				]
			}

			return [true, buffer];
		}

		return [false, buffer];
	}
}

// ******************************** application ********************************

class App {
	public readonly hostname: string;
	public readonly flows: Flow[];

	public constructor(hostname: string, conf: Record<string, Step[]>) {
		this.hostname = hostname.toLocaleLowerCase();
		this.flows = Object.entries(conf).map(a => {
			const flow = new Flow(...a);

			for (let i = 0; i < flow.paths.length; i++) {
				let step: Step | null = flow.paths[i].firstStep;
				while (step) {
					Object.entries(DefaultStep).forEach(([k, v]) => {
						k in (step as Step) || Object.assign(step, { [k]: v })
					});
					step = step.Then;
				}
			}

			return flow;
		});
	}

	public hasOrigin(origin?: string) {
		return origin && origin.toLocaleLowerCase().endsWith(this.hostname);
	}

	public run(trigger: Trigger, socket: WebSocket, buffer?: Buffer) {
		this.flows.forEach(a => {
			const [ok, buff] = a.probe(trigger, buffer);
			return ok && a.run(socket, buff);
		});
	}

	public static only(origin?: string) {
		const socketApps = apps.filter(a => a.hasOrigin(origin));

		return function (this: WebSocket, trigger: Trigger, buffer?: Buffer) {
			socketApps.forEach(a => a.run(trigger, this, buffer));
		}
	}
}

const apps = process.argv.slice(2).map(fp => {
	try {
		const file = readFileSync(fp, { encoding: `utf8` });
		const conf = JSON.parse(file);

		return new App(basename(fp).replace(/\.json$/i, ``), conf);
	} catch (e) {
		console.error(`error parsing app conf "${fp}": ${(e as Error).message}`);
		process.exit(1);
	}
});


console.log(`
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


                 888                          d8b          
                 888                          Y8P          
                 888                                       
 8888b.  888d888 888888 .d88b.  88888b.d88b.  888 .d8888b  
    "88b 888P"   888   d8P  Y8b 888 "888 "88b 888 88K      
.d888888 888     888   88888888 888  888  888 888 "Y8888b. 
888  888 888     Y88b. Y8b.     888  888  888 888      X88 
"Y888888 888      "Y888 "Y8888  888  888  888 888  88888P' 
										  
    (c) 2022 Alexandru Catrina <alex@codeissues.net>

     Version: ${version}
    Homepage: ${homepage}
    DateTime: ${new Date()}
    IP4 addr: ${HOST}
        Port: ${PORT} (tcp)
        Apps: ${apps.length} available
   Protected: ${AUTH ? `yes; JWT signature required` : `no; anyone can join`}

`);

const ws = new WebSocketServer({ noServer: true });
const api = express();
const http = createServer(api);

http.on(`upgrade`, (request, socket, head) => {
	ws.handleUpgrade(request, socket, head, socket => ws.emit(`connection`, socket, request));
});

api.patch(`/_resume/:id`, express.raw({ type: `*/*` }), (req, res) => {
	const { id } = req.params;
	const exists = Path.Pendings.has(id);

	system(`receiving ${exists ? "a pending" : "an expired"} ID "${id}" to resume ...`);

	res.sendStatus(exists ? 204 : 404);

	const payload = Readable.from(req.body.toString());

	Path.resume(id, payload);
});

ws.on(`connection`, async (socket, request) => {
	const { authorization, origin } = request.headers;
	system(`new connection from "${origin}" with auth? ${!!authorization}`);

	try {
		await guard(authorization); // throws an error if not valid

		const socketApps = App.only(origin).bind(socket);
		socketApps(Trigger.JOIN);

		socket.on(`close`, () => socketApps(Trigger.QUIT));
		socket.on(`message`, message => message instanceof Buffer
			? socketApps(Trigger.TASK, message)
			: system(`unexpected message from socket as ${typeof message}`));
	} catch (e) {
		socket.close();
		system(`closing socket because it's not authorized to access app(s)`);
	}
});

http.listen(PORT, HOST, () => {
	system(`ready; up and running v${version}`);
});