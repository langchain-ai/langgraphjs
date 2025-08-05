// MIT License
//
// Copyright (c) Hiroki Osame <hiroki.osame@gmail.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// https://github.com/privatenumber/tsx/tree/28a3e7d2b8fd72b683aab8a98dd1fcee4624e4cb
import path from "node:path";
import os from "node:os";

/**
 * Cache directory is based on the user's identifier
 * to avoid permission issues when accessed by a different user
 */
const { geteuid } = process;
const userId = geteuid
  ? // For Linux users with virtual users on CI (e.g. Docker)
    geteuid()
  : // Use username on Windows because it doesn't have id
    os.userInfo().username;

/**
 * This ensures that the cache directory is unique per user
 * and has the appropriate permissions
 */
export const tmpdir = path.join(os.tmpdir(), `tsx-${userId}`);
