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

const { EventEmitter } = require('events');
const { accept, exit, init, loop, Signal, Status, Ticket } = require('.');

const flow = {
    "dummy async": {
        "Then": {
            "AsyncAction": "test://250",
            "Then": {
                "Then": null
            }
        }
    },
    "dummy error": {
        "Action": "error://..."
    },
    "dummy fault tolerant": {
        "Action": "error2://...",
        "ContinueOnError": true,
        "Then": {}
    },
    "dummy patch": {
        "AsyncAction": "patch://..."
    },
    "dummy flow": {
        "Then": {
            "Then": {
                "Then": null
            }
        }
    },
    "undef dummy flow": null
};

init().then(() => {
    setTimeout(() => exit(), 3000);
})

describe(`loop throughout the entire thread`, () => {

    it(`should fail to finish flow if no worker available`, async () => {
        const run = (resolve, reject) => {
            setTimeout(() => resolve(), 1900);

            const _loop = new EventEmitter();

            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());
            _loop.on(Signal.DONE, () => {
                reject(new Error(`no worker to resolve`));
            });

            const thread = {
                episode: { "Action": "worker://unavailable" },
                session: "test.session.workless",
                payload: Buffer.alloc(0),
                height: 1,
                index: 1,
                title: "dummy flow without a worker",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run 3 times`, async () => {
        await accept(`?`, t => t.done());

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();

            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());

            _loop.on(Signal.DONE, (_, index) => {
                if (index === 3) {
                    resolve();
                } else {
                    reject(new Error(`${index} === 3`));
                }
            });

            const thread = {
                episode: flow["dummy flow"],
                session: "test.session1",
                payload: Buffer.alloc(0),
                height: 3,
                index: 1,
                title: "dummy flow",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run 30 times`, async () => {
        await accept(`?`, t => t.done());

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());

            _loop.on(Signal.DONE, (_, index) => {
                if (index === 30) {
                    resolve();
                } else {
                    reject(new Error(`${index} === 30`));
                }
            });

            const flow30 = (obj, max) => {
                return max < 30
                    ? flow30({ "Then": obj }, max + 1)
                    : obj
            };

            const thread = {
                episode: flow30(flow["undef dummy flow"], 0),
                session: "test.session30",
                payload: Buffer.alloc(0),
                height: 30,
                index: 1,
                title: "undef dummy flow with 30 thens",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run, wait, then continue`, async () => {
        let hasWaited = false;

        await accept(`test`, t => {
            t.wait();
            const delay = t.task.action.split(`://`).pop();
            setTimeout(() => t.done(), delay);
        });

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());
            _loop.on(Signal.WAIT, () => {
                hasWaited = true;
            });

            _loop.on(Signal.DONE, (_, index) => {
                if (index === 3 && hasWaited) {
                    resolve();
                } else {
                    reject(new Error(`${index} === 3 && ${hasWaited}`));
                }
            });


            const thread = {
                episode: flow["dummy async"],
                session: "test.session.async",
                payload: Buffer.alloc(0),
                height: 3,
                index: 1,
                title: "dummy async flow",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run and wait, no continue`, async () => {
        await accept(`test`, t => {
            t.wait();
        });

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());
            _loop.on(Signal.WAIT, () => {
                resolve();
            });

            _loop.on(Signal.DONE, () => {
                reject();
            });

            const thread = {
                episode: flow["dummy async"],
                session: "test.session.async.stuck",
                payload: Buffer.alloc(0),
                height: 3,
                index: 1,
                title: "dummy async flow but does not continue",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run, wait and be patched`, async () => {
        let hasWaited = false;

        await accept(`patch`, t => {
            t.wait();
        });

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => reject());
            _loop.on(Signal.WAIT, () => {
                hasWaited = true;

                setTimeout(async () => {
                    await Ticket.patch("test.session.async.patch", Buffer.from(`looking for ciri`))
                }, 500);
            });

            _loop.on(Signal.DONE, (payload) => {
                if (hasWaited && payload.toString() === `looking for ciri`) {
                    resolve();
                } else {
                    reject(new Error(`${hasWaited} && ${payload.toString()} === "looking for ciri"`));
                }
            });

            const thread = {
                episode: flow["dummy patch"],
                session: "test.session.async.patch",
                payload: Buffer.alloc(0),
                height: 1,
                index: 1,
                title: "dummy async flow with defer patch",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run and halt`, async () => {
        await accept(`error`, t => {
            t.fail();
        });

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => resolve());

            _loop.on(Signal.DONE, () => {
                reject();
            });

            const thread = {
                episode: flow["dummy error"],
                session: "test.session.error",
                payload: Buffer.alloc(0),
                height: 1,
                index: 1,
                title: "dummy async flow with error",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });

    it(`should run, halt but continue on error`, async () => {
        let hasError = false;

        await accept(`error2`, t => {
            t.fail(`must continue on error`);
        });

        const run = (resolve, reject) => {
            const _loop = new EventEmitter();
            _loop.on(Signal.TICK, next => next());
            _loop.on(Signal.HALT, () => {
                hasError = true;
            });

            _loop.on(Signal.DONE, () => {
                if (hasError === false) {
                    resolve();
                } else {
                    reject(new Error(`${hasError} === false`));
                }
            });

            const thread = {
                episode: flow["dummy fault tolerant"],
                session: "test.session.fault.tolerant",
                payload: Buffer.alloc(0),
                height: 2,
                index: 1,
                title: "dummy async flow fault tolerant",
                author: "test",
                ipAddr: "x.x.x.x",
                origin: "localhost",
                events: _loop,
            };

            loop(thread);
        };

        return new Promise(run);
    });
});