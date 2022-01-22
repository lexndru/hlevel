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

import { version, homepage } from './package.json';

import { EventEmitter } from 'events';
import { createClient } from 'redis';
import { v4 as uuidv4 } from 'uuid';

export enum Status {
	NEW = `new`,
	DELEGATED = `delegated`,
	WORK_IN_PROGRESS = `work in progress`,
	SUCCESSFUL_DONE = `successfully finished`,
	FAILED = `failed; %v`,
	BLOCKED = `blocked; %v`,
}

export enum Signal {
	DONE = `done`,
	HALT = `halt`,
	TICK = `tick`,
	WAIT = `wait`,
}

export interface Episode {
	readonly AsyncAction?: string;
	readonly Action?: string;
	readonly Comment?: string;
	readonly ContinueOnError?: boolean;
	readonly Detached?: boolean;
	readonly HttpHeaders?: Record<string, string>;
	readonly HttpTimeout?: number;
	readonly HttpMethod?: string;
	readonly HttpSchema?: string;
	readonly Then?: Episode;
}

export interface Thread {
	readonly episode: Episode;
	readonly session: string;
	readonly payload: Buffer;
	readonly height: number;
	readonly index: number;
	readonly title: string;
	readonly author: string;
	readonly ipAddr: string;
	readonly origin: string;
	readonly events: EventEmitter;
}

export interface Task {
	readonly _datetime: string;
	readonly _version: string;
	readonly session: string; // session of the thread
	readonly ticket: string;  // random uuid
	readonly author: string;  // author of the request
	readonly ipAddr: string;  // ip addr of the author
	readonly origin: string;  // origin of the request e.g. app client
	readonly height: string;  // the total height of thread
	readonly index: string;   // current index of thread
	readonly title: string;   // title or name of the running flow
	readonly state: string;   // current state of the thread
	readonly status: string;  // last status for the thread
	readonly action: string;  // the action that must be performed
	readonly comment: string; // optional comment alongside title
	readonly payload: string; // payload attached to action
	readonly options: string;
}

export interface AsyncTask extends Task {
	readonly async: string;
}

const taskNotification = (schema: string, ticket: string) => `<${schema}>.${ticket}`;
const taskInProgress = (session: string) => `.${session}`;
const taskArchived = (session: string) => `!${session}`;

const duplex = createClient();
const signal = createClient();

export async function init(): Promise<void> {
	duplex.on(`error`, (err: Error) => {
		console.error(`redis error (duplex): ${err.message}`);
	});

	signal.on(`error`, (err: Error) => {
		console.error(`redis error (signal): ${err.message}`);
	})

	await duplex.connect();
	await signal.connect();
}

export function exit(): void {
	duplex.quit();
	signal.quit();
}

export function loop(thread: Thread): void {
	const { episode: { ContinueOnError, Then }, session, height, index, events } = thread;
	const loopThreadId = [session, height, index].join(`:`);
	const currentTask = task.call(thread);

	const next = () => {
		signal.subscribe(loopThreadId, (signalMessage: string) => {
			if (signalMessage === Signal.WAIT) {
				duplex.hGet(session, `status`).then(status => {
					events.emit(Signal.WAIT, status ? Buffer.from(status) : Buffer.alloc(0), index, thread);
				});
			} else {
				signal.unsubscribe(loopThreadId); // NOTE: don't expect any more signals when task is done or halted
				if (signalMessage === Signal.HALT && ContinueOnError === false) {
					duplex.hGet(session, `status`).then(status => {
						duplex.rename(taskInProgress(session), taskArchived(session)); // close loop with error
						events.emit(Signal.HALT, status ? Buffer.from(status) : Buffer.alloc(0), index, thread);
					});
				} else {
					duplex.hGet(session, `payload`).then(payload => {
						const newPayload = payload ? Buffer.from(payload, `base64`) : Buffer.alloc(0);
						if (Then) {
							loop({ ...thread, episode: Then, index: index + 1, payload: newPayload });
						} else {
							duplex.rename(taskInProgress(session), taskArchived(session)); // close loop clean
							events.emit(signalMessage, newPayload, index, thread);
						}
					});
				}
			}
		});

		send(currentTask);
	};

	events.emit(Signal.TICK, next, currentTask, thread);
}

function task(this: Thread): Task | AsyncTask {
	const { episode, session, height, index, title, author, ipAddr, origin } = this;
	const { AsyncAction, Action, ContinueOnError, Comment, Detached, Then, ...$ } = episode;
	const [action, isAsync] = AsyncAction ? [AsyncAction, true] : [Action || ``, false];

	const task: Task = {
		_version: version,
		_datetime: new Date().toISOString(),
		ticket: uuidv4(),
		author,
		ipAddr,
		origin,
		session,
		action,
		title,
		state: ``,
		index: index.toString(),
		height: height.toString(),
		status: Status.NEW,
		comment: Comment || ``,
		payload: (this.payload || ``).toString(`base64`),
		options: JSON.stringify($ || {}),
	};

	return isAsync ? { ...task, async: `_async/${this.session}` } as AsyncTask : task;
}

function send(task: Task | AsyncTask): void {
	const serialized = Object.entries(task);
	const permanentKey = [task.session, task.height, task.index].join(`:`);
	const schema = task.action.split(`://`, 2).shift() || `?`;
	const multi = duplex.multi();

	multi.hSet(task.session, serialized);
	multi.hSet(permanentKey, serialized);
	multi.rPush(taskInProgress(task.session), permanentKey);
	multi.publish(taskNotification(schema, task.ticket), task.session);
	multi.exec();
}

export class Ticket {
	public readonly task: Task | AsyncTask;
	public readonly uuid: string;
	public readonly isAsync: boolean;
	public readonly channel: string;

	public constructor(task: Task | AsyncTask) {
		this.task = task;
		this.uuid = uuidv4();
		this.isAsync = !! /*boolean*/ (this.task as AsyncTask).async;
		this.channel = [task.session, task.height, task.index].join(`:`);
	}

	public done() {
		duplex.hSet(this.task.session, `status`, Status.SUCCESSFUL_DONE);
		duplex.publish(this.channel, Signal.DONE);
	}

	public wait(reason: string) {
		duplex.hSet(this.task.session, `status`, Status.BLOCKED.replace(`%v`, reason));
		duplex.publish(this.channel, Signal.WAIT);
	}

	public fail(reason: string) {
		duplex.hSet(this.task.session, `status`, Status.FAILED.replace(`%v`, reason));
		duplex.publish(this.channel, Signal.HALT);
	}

	public update(buffer: Buffer) {
		duplex.hSet(this.task.session, `payload`, buffer.toString(`base64`));
	}

	public static async patch(session: string, payload: Buffer) {
		const lastEpisode = await duplex.lIndex(taskInProgress(session), -1);

		if (lastEpisode) {
			const multi = duplex.multi();
			multi.hSet(session, `payload`, payload.toString(`base64`));
			multi.hSet(session, `status`, Status.SUCCESSFUL_DONE);
			multi.publish(lastEpisode, Signal.DONE);
			multi.exec();
		}

		return lastEpisode;
	}
}

export async function accept(pattern: string, callback: (t: Ticket) => void | Promise<void>) {
	await signal.pSubscribe(`<${pattern}>.*`, async (session) => {
		const {
			_datetime,
			_version,
			payload,
			comment,
			options,
			action,
			height,
			status,
			author,
			ipAddr,
			origin,
			ticket,
			title,
			state,
			index,
			async,
		} = await duplex.hGetAll(session);

		const task: Task = {
			_datetime,
			_version,
			session,
			payload,
			comment,
			options,
			action,
			height,
			status,
			author,
			ipAddr,
			origin,
			ticket,
			title,
			state,
			index,
		};

		callback(new Ticket(async ? { ...task, async } as AsyncTask : task));
	});
}

export const license = (apps: number) => console.log(`
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


    ___    __   _      ________      ________ _      
   / / |   \\ \\ | |    |  ____\\ \\    / /  ____| |     
  / /| |__  \\ \\| |    | |__   \\ \\  / /| |__  | |     
 < < | '_ \\  > > |    |  __|   \\ \\/ / |  __| | |     
  \\ \\| | | |/ /| |____| |____   \\  /  | |____| |____ 
   \\_\\_| |_/_/ |______|______|   \\/   |______|______|

    (c) 2022 Alexandru Catrina <alex@codeissues.net>

     Version: ${version}
    Homepage: ${homepage}
    DateTime: ${new Date()}
    IP4/Host: ${process.env.HOST}
        Port: ${process.env.PORT} (tcp)
        Apps: ${apps} available
   Protected: ${process.env.AUTH ? `yes; JWT auth required` : `no; anyone can join`}
`);