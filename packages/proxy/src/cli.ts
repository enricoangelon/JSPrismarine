import { run } from './cli/Cli';

/**
 * The `jsp-proxy` entry point.
 *
 * Every handle the proxy owns is `unref`ed, because a library must not keep its host process
 * alive. In a process whose only job is the proxy that leaves nothing holding the event loop
 * open, so this interval does it for as long as the command runs.
 */
const keepAlive = setInterval(() => {}, 1 << 30);

void run(process.argv.slice(2))
    .then((code) => {
        process.exitCode = code;
    })
    .finally(() => clearInterval(keepAlive));
