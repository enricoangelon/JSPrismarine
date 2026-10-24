import { describe, expect, it } from 'vitest';
import { UsageError, parseAddress, run } from './Cli';

const capture = () => {
    const lines = { out: [] as string[], err: [] as string[] };
    return { lines, io: { out: (line: string) => lines.out.push(line), err: (line: string) => lines.err.push(line) } };
};

describe('parseAddress', () => {
    it('reads host:port', () => {
        expect(parseAddress('127.0.0.1:19133', '--backend')).toEqual({ host: '127.0.0.1', port: 19133 });
    });

    it('gives a bare host the default Bedrock port', () => {
        expect(parseAddress('example.org', '--backend')).toEqual({ host: 'example.org', port: 19132 });
    });

    it.each(['127.0.0.1:', ':19132', '127.0.0.1:0', '127.0.0.1:70000', '127.0.0.1:abc'])('refuses %s', (value) => {
        expect(() => parseAddress(value, '--backend')).toThrow(UsageError);
    });
});

describe('run', () => {
    it('exits with status 2 when no backend is given', async () => {
        const { lines, io } = capture();

        expect(await run([], io, async () => {})).toBe(2);
        expect(lines.err.join('\n')).toContain('backend');
    });

    it('exits with status 2 on a malformed address', async () => {
        const { lines, io } = capture();

        expect(await run(['--backend', '127.0.0.1:nope'], io, async () => {})).toBe(2);
        expect(lines.err.join('\n')).toContain('--backend must be host:port');
    });
});
