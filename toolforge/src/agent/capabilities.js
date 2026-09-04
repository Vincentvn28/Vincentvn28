import { arch, cpus, freemem, hostname, platform, release, totalmem, userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Toolchains worth advertising, so tasks can require what they need. */
const PROBES = [
  { name: 'node', argv: ['node', ['--version']] },
  { name: 'npm', argv: ['npm', ['--version']] },
  { name: 'python', argv: ['python3', ['--version']] },
  { name: 'git', argv: ['git', ['--version']] },
  { name: 'docker', argv: ['docker', ['--version']] },
  { name: 'go', argv: ['go', ['version']] },
  { name: 'java', argv: ['java', ['-version']] },
  { name: 'rust', argv: ['rustc', ['--version']] },
  { name: 'make', argv: ['make', ['--version']] },
  { name: 'claude', argv: ['claude', ['--version']] },
];

/**
 * Describe this machine so the hub can match tasks to it.
 * @param {{extraTools?: string[]}} [opts]
 * @returns {Promise<any>}
 */
export async function detectCapabilities(opts = {}) {
  const probes = [
    ...PROBES,
    ...(opts.extraTools ?? []).map((name) => ({ name, argv: [name, ['--version']] })),
  ];

  const results = await Promise.all(
    probes.map(async ({ name, argv }) => {
      try {
        const { stdout, stderr } = await run(argv[0], argv[1], { timeout: 4_000 });
        const version = firstLine(stdout || stderr);
        return [name, version];
      } catch {
        return [name, null];
      }
    }),
  );

  /** @type {Record<string, string>} */
  const tools = {};
  for (const [name, version] of results) {
    if (version) tools[name] = version;
  }

  return {
    os: platform(),
    osRelease: release(),
    arch: arch(),
    hostname: hostname(),
    user: safeUser(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model?.trim() ?? 'unknown',
    memGb: Number((totalmem() / 1024 ** 3).toFixed(1)),
    freeMemGb: Number((freemem() / 1024 ** 3).toFixed(1)),
    nodeVersion: process.version,
    tools,
    detectedAt: new Date().toISOString(),
  };
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim() || null;
}

function safeUser() {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}
