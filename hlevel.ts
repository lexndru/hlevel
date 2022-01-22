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

import "dotenv/config";
import { init } from ".";
import { version, homepage } from "./package.json";

const [mod, ...args] = process.argv.slice(2);

function help() {
    console.log(`
    hlevel v${version} by Alexandru Catrina
    manual ${homepage}

    options:
        server app(1) [app(2) app(3) ... app(n)]
        worker
    
    where app(i) is a valid JSON high level flow
    `);
}

switch (mod) {
    case "server":
        const { default: startServer, createApp } = require("./server");
        args.forEach(createApp); // no whitespace allowed?
        init().then(startServer);
        break;
    case "worker":
        const { default: startWorker } = require("./worker");
        init().then(startWorker);
        break;
    default:
        help();
}