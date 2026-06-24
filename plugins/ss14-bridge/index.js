import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const info = {
    id: 'ss14-bridge',
    name: 'Rot of Elizium SS14 Bridge',
    description: 'Connects the Rot of Elizium UI to the local SS14 named-pipe bridge.',
};

const PIPE_PATH = '\\\\.\\pipe\\ss14-content-bridge';
const REQUEST_TIMEOUT_MS = 3500;
const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const productRoot = path.resolve(pluginDirectory, '..', '..', '..');
const injectorRoot = path.join(productRoot, 'ss');

const builtInjector = path.join(productRoot, 'bridge', 'inject.exe');

function requestBridge(payload) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(PIPE_PATH);
        let buffer = '';
        let settled = false;

        const finish = (error, value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            error ? reject(error) : resolve(value);
        };

        const timer = setTimeout(
            () => finish(new Error('SS14 bridge request timed out.')),
            REQUEST_TIMEOUT_MS,
        );

        socket.setEncoding('utf8');
        socket.once('connect', () => {
            socket.write(`${JSON.stringify({
                ...payload,
                id: randomUUID(),
            })}\n`);
        });
        socket.on('data', chunk => {
            buffer += chunk;
            const newline = buffer.indexOf('\n');
            if (newline < 0) {
                return;
            }

            try {
                finish(null, JSON.parse(buffer.slice(0, newline)));
            } catch {
                finish(new Error('SS14 bridge returned invalid JSON.'));
            }
        });
        socket.once('error', error => finish(error));
        socket.once('end', () => {
            if (!settled) {
                finish(new Error('SS14 bridge closed the connection.'));
            }
        });
    });
}

function bridgeError(error) {
    const message = error?.code === 'ENOENT'
        ? 'SS14 bridge is not running.'
        : String(error?.message || error);
    return { ok: false, error: message };
}

function resolveInjectorCommand(timeoutSeconds) {
    const candidates = [
        { path: process.env.ROT_OF_ELIZIUM_EXECUTABLE, args: [] },
        { path: builtInjector, args: [] },
        { path: path.join(injectorRoot, 'nuitka-dist', 'main.exe'), args: [] },
        { path: path.join(injectorRoot, 'main.py'), python: true },
    ];

    for (const candidate of candidates) {
        if (!candidate.path || !fs.existsSync(candidate.path)) continue;
        const args = ['--inject-only', '--inject-timeout', String(timeoutSeconds), ...candidate.args];
        if (candidate.python) {
            const venv = path.join(injectorRoot, '.venv', 'Scripts', 'python.exe');
            if (!fs.existsSync(venv)) continue;
            return { command: venv, args: [candidate.path, ...args], cwd: injectorRoot };
        }
        return { command: candidate.path, args, cwd: path.dirname(candidate.path) };
    }

    throw new Error('Bridge injector was not found.');
}

function runInjector(timeoutSeconds) {
    const resolved = resolveInjectorCommand(timeoutSeconds);
    return new Promise((resolve, reject) => {
        const child = spawn(resolved.command, resolved.args, {
            cwd: resolved.cwd,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PYTHONUTF8: '1',
                PYTHONIOENCODING: 'utf-8',
            },
        });
        let stdout = '';
        let stderr = '';
        const maxOutput = 32 * 1024;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout = (stdout + chunk).slice(-maxOutput);
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-maxOutput);
        });
        child.once('error', reject);
        child.once('close', code => {
            const lines = `${stdout}\n${stderr}`
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean);
            const jsonLine = [...lines]
                .reverse()
                .find(line => line.startsWith('{') && line.endsWith('}'));
            let result = null;
            if (jsonLine) {
                try {
                    result = JSON.parse(jsonLine);
                } catch {
                    result = null;
                }
            }

            if (code === 0 && result?.ok) {
                resolve(result);
                return;
            }
            reject(new Error(result?.error || lines.at(-1) || `Injector exited with code ${code}.`));
        });
    });
}

export async function init(router) {
    router.get('/status', async (_request, response) => {
        try {
            response.json(await requestBridge({ action: 'ping' }));
        } catch (error) {
            response.status(503).json(bridgeError(error));
        }
    });

    router.post('/messages', async (request, response) => {
        const afterId = Number.isSafeInteger(request.body?.after_id)
            ? request.body.after_id
            : -1;
        try {
            response.json(await requestBridge({
                action: 'get_chat_messages',
                after_id: afterId,
            }));
        } catch (error) {
            response.status(503).json(bridgeError(error));
        }
    });

    router.post('/send', async (request, response) => {
        const text = String(request.body?.text || '').trim();
        const channel = String(request.body?.channel || 'speech');
        const radioKey = String(request.body?.radio_key || ';');

        if (!text || text.length > 1000) {
            return response.status(400).json({
                ok: false,
                error: 'Text must contain between 1 and 1000 characters.',
            });
        }

        try {
            response.json(await requestBridge({
                action: 'send_chat',
                text,
                channel,
                radio_key: radioKey,
            }));
        } catch (error) {
            response.status(503).json(bridgeError(error));
        }
    });

    router.post('/inject', async (request, response) => {
        try {
            const status = await requestBridge({ action: 'ping' });
            if (status.ok) {
                return response.json({ ok: true, already_running: true });
            }
        } catch {
            // The injector is only started when the pipe is genuinely unavailable.
        }

        const requestedTimeout = Number(request.body?.timeout);
        const timeout = Number.isFinite(requestedTimeout)
            ? Math.max(5, Math.min(120, requestedTimeout))
            : 45;
        try {
            const result = await runInjector(timeout);
            response.json({ ...result, already_running: false });
        } catch (error) {
            response.status(503).json(bridgeError(error));
        }
    });
}
