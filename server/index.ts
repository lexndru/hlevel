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
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { createServer, IncomingMessage } from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import express from 'express';
import { AsyncTask, Episode, license, loop, Signal, Task, Thread, Ticket } from '..';

const IS_DEBUG = process.env.IS_DEBUG === `true`;

const debug = IS_DEBUG
	? function debug(text: string) {
		console.log(
			'\x1b[2m%s\x1b[0m \x1b[2m%s\x1b[0m',
			new Date().toISOString(), text);
	}
	: (_: string) => { };

function info(text: string, author: string) {
	console.log(
		'\x1b[2m%s\x1b[0m %s \x1b[2m%s\x1b[0m',
		new Date().toISOString(), author, text);
}

function log(branch: string, session: string, text?: string) {
	console.log(
		'\x1b[2m%s\x1b[0m \x1b[1m%s\x1b[0m \x1b[2m%s\x1b[0m \x1b[32m%s\x1b[0m',
		new Date().toISOString(), session, branch, text || ``);
}

function err(branch: string, session: string, text?: string) {
	console.log(
		'\x1b[2m%s\x1b[0m \x1b[1m%s\x1b[0m \x1b[2m%s\x1b[0m \x1b[31m%s\x1b[0m',
		new Date().toISOString(), session, branch, text || ``);
}

type App = Record<string, Episode>;

const apps: Map<string, App> = new Map();

export function createApp(filepath: string): void {
	const filename = basename(filepath).replace(/\.jsonc?$/i, ``);
	const contents = readFileSync(filepath, { encoding: `utf8` });

	try {
		apps.set(filename, JSON.parse(contents) as App);
	} catch (e) {
		console.error(`can't create app from "${filepath}", ${(e as Error).message}`);
		process.exit(1);
	}
}

interface Client {
	readonly author: string;
	readonly ipAddr: string;
	readonly origin: string;
	readonly originApp: App;
	readonly channel: EventEmitter;
}

const len = (e: Episode, n: number): number => e.Then ? len(e.Then, n + 1) : n;

function createThread(this: Client, title: string, payload?: Buffer): Thread {
	const firstEpisode = this.originApp[title];

	return {
		title,
		author: this.author,
		ipAddr: this.ipAddr,
		origin: this.origin,
		events: new EventEmitter(), // each thread must have its own channel
		height: len(firstEpisode, 1),
		session: `0x` + uuidv4().replace(/\-/g, ``).toUpperCase(),
		// changed with each iteration
		episode: firstEpisode,
		payload: payload || Buffer.alloc(0),
		index: 1,
	};
}

const signals = {
	done: Buffer.from(`.`),
	halt: Buffer.from(`!`),
	wait: Buffer.from(`^`),
};

function startThread(this: Client, thread: Thread): void {
	thread.events.on(Signal.TICK, (delegate: Function, task: Task | AsyncTask) => {
		const friendlyMessage = task.comment
			? thread.title + `, ` + task.comment
			: thread.title;

		log(`[${task.index}/${thread.height}] tick  `, task.session, friendlyMessage);

		delegate();
	});

	thread.events.on(Signal.WAIT, (_: Buffer, index: number) => {
		log(`[${index}/${thread.height}] wait ^`, thread.session, thread.title);

		// should this also propagate?
	});

	thread.events.on(Signal.DONE, (payload: Buffer, index: number) => {
		log(`[${index}/${thread.height}] done .`, thread.session, thread.title);

		this.channel.emit(thread.session, signals.done, payload);
	});

	thread.events.on(Signal.HALT, (reason: Buffer, index: number) => {
		err(`[${index}/${thread.height}] halt !`, thread.session, thread.title);

		this.channel.emit(thread.session, signals.halt, reason);
	});

	loop(thread);
}

const ws = new WebSocketServer({ noServer: true });
const api = express();
const http = createServer(api);

http.on(`upgrade`, (request, socket, head) => {
	const author = (request.url || '').replace(/\W/g, ``);
	const origin = (request.headers.origin || ``).split(`://`).pop() as string;
	const ipAddr = request.headers['x-forwarded-for'] as string || request.socket.remoteAddress || 'x.x.x.x';

	debug(`peer ${ipAddr} connecting as "${author}" from ${origin}`);

	if (apps.has(origin)) {
		const client: Client = {
			author, ipAddr, origin, originApp: apps.get(origin) as App, channel: new EventEmitter()
		};

		ws.handleUpgrade(request, socket, head, socket => ws.emit(`connection`, socket, request, client));
	} else {
		socket.destroy();
	}
});

enum Trigger {
	JOIN = `#join`,
	TASK = `#task`,
	QUIT = `#quit`,
}

const TASK_DELIM = "\r";
const TEXT_DELIM = ` `;

interface Message {
	readonly data: Buffer;
	readonly slot: string;
	readonly refs: string[];
}

function decodeTaskMessage(this: Buffer, taskList: string[]): Message | undefined {
	const delim = this.indexOf(TASK_DELIM);
	if (delim > -1) {
		const task = this.slice(0, delim).toString(); // e.g. slot.<TaskName> or .<TaskName>
		const data = this.slice(delim + 1);
		const [slot, name] = task.split(`.`);
		const exactMatch = (a: string) => a.includes(Trigger.TASK + `.` + name);

		return {
			data,
			slot,
			refs: taskList.filter(exactMatch),
		};
	}

	return undefined;
}

const network = new EventEmitter();
const connections: Map<string, WebSocket> = new Map();

function peerMessage(this: WebSocket, message: string, from: string) {
	this.send(from + TEXT_DELIM + message);
}

function handleTask(this: WebSocket, message: RawData, taskList: string[], client: Client) {
	if (message instanceof Buffer) {
		const create = createThread.bind(client);
		const start = startThread.bind(client);
		const dmsg = decodeTaskMessage.call(message, taskList);

		if (IS_DEBUG) {
			debug(`task request from ${client.author} decoded slot as ${dmsg?.slot}`);
			debug(`task request from ${client.author} decoded refs as ${dmsg?.refs}`);
			debug(`task request from ${client.author} decoded data as buffer of ${dmsg?.data ? dmsg.data.length / 1024 : `-`} kb`);
		}

		dmsg?.refs.map(a => create(a, dmsg?.data)).forEach(a => {
			client.channel.on(a.session, (signal: Buffer, data: Buffer) => {
				this.send(Buffer.concat([Buffer.from(dmsg?.slot), signal, data]));
			});

			info(`task request "${dmsg?.slot}" allocated: ${a.session}`, client.author);

			start(a);
		});
	} else {
		debug(`unsupported data from socket`);
	}
}

function handleText(this: WebSocket, textMessage: string, sender: string) {
	const delim = textMessage.indexOf(TEXT_DELIM);
	const receiver = textMessage.slice(0, delim).trim();
	const receiverMessage = textMessage.slice(delim + 1).trim();

	if (receiver) {
		network.emit(receiver, receiverMessage, sender);
	}

	if (IS_DEBUG) {
		if (!connections.has(receiver)) {
			debug(`sending message to "${receiver}" from "${sender}" but receiver is not online`);
		} else if (!receiver) {
			debug(`cannot send text message from "${sender}" because there's no receiver: ${textMessage}`);
		}
	}
}

ws.on(`connection`, async (socket: WebSocket, { }: IncomingMessage, client: Client) => {
	const create = createThread.bind(client);
	const start = startThread.bind(client);

	info(`welcome ${client.ipAddr} from ${client.origin}`, client.author);

	const titles = Object.keys(client.originApp);
	const onJoin = titles.filter(a => a.indexOf(Trigger.JOIN) > -1);
	const onTask = titles.filter(a => a.indexOf(Trigger.TASK) > -1);
	const onQuit = titles.filter(a => a.indexOf(Trigger.QUIT) > -1);

	const onBinary = handleTask.bind(socket);
	const onText = handleText.bind(socket);
	const peer = peerMessage.bind(socket);

	socket.on(`message`, (message, isBinary) => isBinary
		? onBinary(message, onTask, client)
		: onText(message.toString(`utf-8`), client.author));

	socket.on(`close`, () => {
		onQuit.map(a => create(a)).forEach(start);

		info(`goodbye ${client.ipAddr} from ${client.origin}`, client.author);

		connections.delete(client.author);
		network.off(client.author, peer);
	});

	onJoin.map(a => create(a)).forEach(start);

	connections.set(client.author, socket);
	network.on(client.author, peer);
});

api.patch(`/_async/:session`, express.raw({ type: `*/*` }), async (req, res) => {
	const key = await Ticket.patch(req.params.session, req.body);

	debug(`resuming session ${req.params.session}, ticket ` + (key ? 'updated' : 'not found'));

	res.sendStatus(key ? 204 : 404);
});

const PORT = Number(process.env.PORT);
const HOST = String(process.env.HOST);

export default function () {
	http.listen(PORT, HOST, () => license(apps.size));
}
