import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(projectRoot, '../..');
const stagedPackageRoot = join(workspaceRoot, 'dist', 'libs', 'cli');
const smokeRoot = await mkdtemp(join(tmpdir(), 'skill-sync-pack-'));
const npmCache = join(smokeRoot, 'npm-cache');
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let packedPath;

function execute(command, args, options = {}) {
  const environment = {
    ...process.env,
    npm_config_cache: npmCache,
    npm_config_update_notifier: 'false',
    ...options.env,
  };
  Reflect.deleteProperty(environment, 'FORCE_COLOR');
  for (const key of options.unsetEnvironment ?? []) Reflect.deleteProperty(environment, key);
  return spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: 'utf8',
    env: environment,
    shell: options.shell ?? false,
  });
}

function requireSuccess(command, args, options = {}) {
  const result = execute(command, args, options);
  if (result.status !== 0) {
    const reason = result.error?.message ?? result.stderr ?? result.stdout;
    throw new Error(`${command} ${args.join(' ')} failed:\n${reason}`);
  }
  return result;
}

function runNpm(args) {
  return requireSuccess(npmExecutable, args, { shell: process.platform === 'win32' });
}

function assertPackedFiles(files) {
  const paths = files.map((file) => file.path);
  for (const required of ['LICENSE', 'README.md', 'dist/cli.js', 'package.json']) {
    if (!paths.includes(required)) throw new Error(`packed artifact is missing ${required}`);
  }
  const unexpected = paths.filter(
    (path) =>
      path !== 'LICENSE' &&
      path !== 'README.md' &&
      path !== 'package.json' &&
      !path.startsWith('dist/'),
  );
  if (unexpected.length > 0) {
    throw new Error(`packed artifact contains unexpected files: ${unexpected.join(', ')}`);
  }
}

function globalExecutable(prefix) {
  return process.platform === 'win32'
    ? join(prefix, 'skill-sync.cmd')
    : join(prefix, 'bin', 'skill-sync');
}

function runInstalled(executable, args, options) {
  return execute(executable, args, {
    ...options,
    env: {
      ...options.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
    },
    shell: process.platform === 'win32',
  });
}

function verifyInteractiveCancellation(executable, options) {
  // macOS ships `expect`; it gives the packaged prompt a real PTY in the macOS CI leg.
  if (process.platform !== 'darwin') return;
  const script = [
    'set timeout 10',
    'spawn $env(SKILL_SYNC_SMOKE_BIN) init',
    'expect "GitHub skill library URL"',
    'send -- "\\003"',
    'expect eof',
    'catch wait result',
    'set status [lindex $result 3]',
    'if {$status != 130} {exit 93}',
    'exit 0',
  ].join('; ');
  const result = execute('/usr/bin/expect', ['-c', script], {
    cwd: options.cwd,
    env: { ...options.env, SKILL_SYNC_SMOKE_BIN: executable },
    unsetEnvironment: ['CI'],
  });
  const output = `${result.stdout}${result.stderr}`;
  if (
    result.status !== 0 ||
    !output.includes('GitHub skill library URL') ||
    !output.includes('CANCELLED: Operation cancelled.')
  ) {
    throw new Error(`globally installed interactive cancellation failed:\n${output}`);
  }
}

try {
  const packedResult = runNpm(['pack', '--json', stagedPackageRoot]);
  const packed = JSON.parse(packedResult.stdout);
  const artifact = packed[0];
  if (packed.length !== 1 || artifact?.filename === undefined) {
    throw new Error('npm pack did not return exactly one package artifact');
  }
  assertPackedFiles(artifact.files ?? []);
  packedPath = join(workspaceRoot, artifact.filename);

  const prefix = join(smokeRoot, 'global-prefix');
  await mkdir(prefix);
  runNpm([
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    packedPath,
  ]);

  const executable = globalExecutable(prefix);
  await access(executable);
  const installedPackageRoot = join(
    prefix,
    process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
    ...artifact.name.split('/'),
  );
  const packageJson = JSON.parse(
    await readFile(join(installedPackageRoot, 'package.json'), 'utf8'),
  );
  if (packageJson.name !== artifact.name || packageJson.version !== artifact.version) {
    throw new Error('installed package identity does not match the packed artifact');
  }
  if (packageJson.bin?.['skill-sync'] !== 'dist/cli.js') {
    throw new Error('packed skill-sync bin metadata is incorrect');
  }
  if (packageJson.engines?.node !== '>=22') throw new Error('packed Node engine is incorrect');
  if (packageJson.publishConfig?.access !== 'public') {
    throw new Error('packed npm access metadata is incorrect');
  }
  if (packageJson.publishConfig?.provenance !== true) {
    throw new Error('packed npm provenance metadata is missing');
  }

  const unrelated = join(smokeRoot, 'unrelated-project');
  const configHome = join(smokeRoot, 'config-home');
  const localSkill = join(smokeRoot, 'local-skill');
  await mkdir(unrelated);
  await mkdir(localSkill);
  await writeFile(
    join(localSkill, 'SKILL.md'),
    '---\nname: local-skill\ndescription: Packed smoke fixture\n---\n\n# Fixture\n',
  );
  const runtime = { cwd: unrelated, env: { SKILL_SYNC_CONFIG_HOME: configHome } };

  const help = runInstalled(executable, ['--help'], runtime);
  if (help.status !== 0 || !help.stdout.includes('Manage Git-backed AI skills')) {
    throw new Error(`globally installed skill-sync --help failed:\n${help.stderr || help.stdout}`);
  }
  const version = runInstalled(executable, ['--version'], runtime);
  if (version.status !== 0 || version.stdout.trim() !== packageJson.version) {
    throw new Error(
      `globally installed skill-sync --version failed:\n${version.stderr || version.stdout}`,
    );
  }
  const invalid = runInstalled(executable, ['not-a-command'], runtime);
  if (
    invalid.status !== 2 ||
    invalid.stdout !== '' ||
    !invalid.stderr.includes('unknown command')
  ) {
    throw new Error(
      `globally installed skill-sync usage failure was incorrect:\n${invalid.stderr || invalid.stdout}`,
    );
  }
  const invalidJson = runInstalled(executable, ['--json', 'info'], runtime);
  const invalidJsonBody = JSON.parse(invalidJson.stdout);
  if (
    invalidJson.status !== 2 ||
    !invalidJson.stderr.includes("missing required argument 'id'") ||
    invalidJson.stdout.trim().split('\n').length !== 1 ||
    invalidJsonBody.ok !== false ||
    invalidJsonBody.errors?.[0]?.code !== 'USAGE_ERROR'
  ) {
    throw new Error(
      `globally installed JSON usage failure was incorrect:\n${invalidJson.stderr || invalidJson.stdout}`,
    );
  }
  verifyInteractiveCancellation(executable, runtime);

  const configured = runInstalled(
    executable,
    ['--no-input', '--json', 'config', 'set', 'defaults.targets', 'codex,claude'],
    runtime,
  );
  const configuredJson = JSON.parse(configured.stdout);
  if (
    configured.status !== 0 ||
    configured.stderr !== '' ||
    configuredJson.ok !== true ||
    configuredJson.command !== 'config:set'
  ) {
    throw new Error(
      `globally installed JSON config workflow failed:\n${configured.stderr || configured.stdout}`,
    );
  }

  const validated = runInstalled(
    executable,
    ['--no-input', '--json', 'validate', localSkill],
    runtime,
  );
  const validatedJson = JSON.parse(validated.stdout);
  if (
    validated.status !== 0 ||
    validated.stderr !== '' ||
    validated.stdout.trim().split('\n').length !== 1 ||
    validatedJson.ok !== true ||
    validatedJson.command !== 'validate' ||
    validatedJson.data?.valid !== true
  ) {
    throw new Error(
      `globally installed JSON validation workflow failed:\n${validated.stderr || validated.stdout}`,
    );
  }
} finally {
  if (packedPath !== undefined) await rm(packedPath, { force: true });
  await rm(smokeRoot, { recursive: true, force: true });
}
