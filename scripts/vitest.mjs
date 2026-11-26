// Starts Vitest from the working directory as the file system spells it.
//
// On Windows a shell can stand in `d:\...` while the disk is `D:\...` (VS Code opens a workspace with the
// drive letter it was given). Vitest then loads its runner under one spelling and the test files' `vitest`
// import under the other: two copies, and every `describe` fails with "Cannot read properties of undefined
// (reading 'config')" because the copy the test file sees was never started. realpathSync.native returns
// the real casing, so both resolve to the same files. Elsewhere this changes nothing.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const cwd = realpathSync.native(process.cwd());
const cli = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
const { status, signal, error } = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
if (error) throw error;
process.exit(status ?? (signal ? 1 : 0));
