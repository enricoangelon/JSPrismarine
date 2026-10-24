import { Logger } from '@jsprismarine/logger';
import yargs from 'yargs/yargs';
import pkg from '../../package.json' with { type: 'json' };
import Proxy from '../Proxy';

/** Output streams used by the CLI, replaceable by callers embedding it. */
export interface CliIo {
    out(line: string): void;
    err(line: string): void;
}

/** A command-line input mistake that should exit with status 2. */
export class UsageError extends Error {}

/** A `host:port` pair as the command line gives it. */
export interface Address {
    readonly host: string;
    readonly port: number;
}

const CONSOLE_IO: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
};

const DEFAULT_PORT = 19132;
const CLI_NAME = Object.keys(pkg.bin)[0] ?? pkg.name;

/**
 * Reads `host:port`, or a bare `host`, which then gets the default Bedrock port.
 * @param flag - the option the value came from, for the error message.
 * @throws {UsageError} When the port is not a number from 1 to 65535.
 */
export const parseAddress = (value: string, flag: string): Address => {
    const separator = value.lastIndexOf(':');
    const host = separator === -1 ? value : value.slice(0, separator);
    const port = separator === -1 ? DEFAULT_PORT : Number(value.slice(separator + 1));

    if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new UsageError(`${flag} must be host:port, got "${value}"`);
    }

    return { host, port };
};

/** Resolves when the process is asked to stop. */
const untilInterrupted = (): Promise<void> =>
    new Promise((resolve) => {
        const stop = () => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            resolve();
        };

        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });

/**
 * Parses the command line and runs the proxy until the process is interrupted.
 *
 * @param argv - arguments after the executable and script, i.e. `process.argv.slice(2)`.
 * @param io - output streams for diagnostics.
 * @param stopped - resolves when the proxy should shut down; defaults to SIGINT or SIGTERM.
 * @returns the process exit code.
 */
export const run = async (
    argv: readonly string[],
    io: CliIo = CONSOLE_IO,
    stopped: () => Promise<void> = untilInterrupted
): Promise<number> => {
    let values;

    try {
        values = await yargs([...argv])
            .scriptName(CLI_NAME)
            .usage('$0 --backend <host:port> [options]')
            .example(
                '$0 --backend 127.0.0.1:19133 --record captures',
                'Relay clients to a local server and record them'
            )
            .strict()
            .showHelpOnFail(false)
            .help('help', 'Show this help message')
            .version('version', 'Show the proxy version', `${CLI_NAME} ${pkg.version}`)
            .exitProcess(false)
            .fail((message, error) => {
                throw new UsageError(message ?? error?.message ?? 'Invalid command-line arguments');
            })
            .options({
                backend: { alias: 'b', type: 'string', demandOption: true, describe: 'Server to relay to, host:port' },
                mirror: {
                    alias: 'm',
                    type: 'string',
                    describe:
                        'Second server that gets the same client packets, host:port; its replies are only recorded'
                },
                listen: {
                    alias: 'l',
                    type: 'string',
                    default: `0.0.0.0:${DEFAULT_PORT}`,
                    describe: 'Address to accept clients on'
                },
                record: {
                    alias: 'r',
                    type: 'string',
                    describe: 'Directory to write one NDJSON recording per player to'
                },
                motd: { type: 'string', describe: 'Server list name' },
                verbose: { alias: 'v', type: 'boolean', describe: 'Log everything the proxy does' }
            })
            .parseAsync();
    } catch (error: unknown) {
        io.err(error instanceof Error ? error.message : String(error));
        return 2;
    }

    // `--help` and `--version` print and leave nothing to run.
    if (values.help === true || values.version === true) return 0;

    let backend: Address;
    let mirror: Address | undefined;
    let listen: Address;
    try {
        backend = parseAddress(values.backend, '--backend');
        mirror = values.mirror === undefined ? undefined : parseAddress(values.mirror, '--mirror');
        listen = parseAddress(values.listen, '--listen');
    } catch (error: unknown) {
        io.err(error instanceof Error ? error.message : String(error));
        return 2;
    }

    const proxy = new Proxy({
        listen,
        backend,
        mirror,
        recordDir: values.record,
        motd: values.motd,
        logger: new Logger(values.verbose === true ? 'silly' : 'info')
    });

    proxy.start();
    await stopped();
    await proxy.close();

    return 0;
};
