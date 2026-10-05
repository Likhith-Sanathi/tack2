// OS sandbox for shell commands (bash, bash_background). On macOS, commands run under
// /usr/bin/sandbox-exec with a Seatbelt profile generated per command:
//   - reads: everything, except folders that hold credentials (~/.ssh, ~/.aws, …)
//   - writes: the project (unless read-only, as in plan mode) and temp/cache folders only;
//     git hooks/config and editor settings in the project stay read-only
//   - network: none, except servers on this machine (localhost)
// Other platforms aren't supported yet; commands there keep needing approval.
//
// The base profile and several rules are adapted from Anthropic's sandbox-runtime
// (https://github.com/anthropic-experimental/sandbox-runtime, Apache-2.0), which Claude Code uses.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SandboxPolicy = {
	/** Whether the project folder is writable (false in plan mode). */
	writeProject: boolean;
	/** Whether the command may reach the network beyond localhost. */
	network: boolean;
};

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Why the sandbox can't be used here, or null if it can. */
export function sandboxUnavailableReason(platform: NodeJS.Platform = process.platform): string | null {
	if (platform !== 'darwin') return `Sandboxing isn't supported on ${platform} yet; commands need approval instead.`;
	if (!fs.existsSync(SANDBOX_EXEC)) return `${SANDBOX_EXEC} was not found.`;
	return null;
}

/** Folders in your home directory that commands may not read, because they hold credentials. */
export const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.docker/config.json', '.kube'];

/**
 * Project paths that stay read-only even when the project is writable. Git hooks and config run
 * code outside the sandbox later (the next time you use git); editor settings can run tasks.
 */
export const PROTECTED_IN_PROJECT = {subpaths: ['.git/hooks', '.vscode', '.idea'], files: ['.git/config', '.gitmodules']};

/** Where caches go inside the sandbox, so tools that cache in your home folder still work. */
export function sandboxCacheDir(): string {
	return path.join(realTmpDir(), 'tack-sandbox-cache');
}

/** Seatbelt matches real paths: /tmp is /private/tmp and /var is /private/var on macOS. */
function real(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function realTmpDir(): string {
	return real(os.tmpdir());
}

/** Escapes a path for use inside a regular expression. */
function regexEscape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A string literal in a Seatbelt profile. */
function str(value: string): string {
	return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// Processes, IPC and system queries ordinary programs need, adapted from sandbox-runtime's base
// profile (itself based on Chrome's sandbox policy).
const BASE_PROFILE = `(version 1)
(deny default)

; Processes
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))

(allow user-preference-read)

; Mach IPC: specific system services only
(allow mach-lookup
  (global-name "com.apple.audio.systemsoundserver")
  (global-name "com.apple.distributed_notifications@Uv3")
  (global-name "com.apple.FontObjectsServer")
  (global-name "com.apple.fonts")
  (global-name "com.apple.logd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.SecurityServer")
)

; POSIX IPC (shared memory, semaphores for e.g. Python multiprocessing)
(allow ipc-posix-shm)
(allow ipc-posix-sem)

(allow iokit-open
  (iokit-registry-entry-class "IOSurfaceRootUserClient")
  (iokit-registry-entry-class "RootDomainUserClient")
  (iokit-user-client-class "IOSurfaceSendRight")
)
(allow iokit-get-properties)

; A safe system socket that gives no network access
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))

(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.bootargs")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfiles")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.ngroups")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.tcsm_available")
  (sysctl-name "kern.tcsm_enable")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "kern.willshutdown")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "machdep.ptrauth_enabled")
  (sysctl-name "security.mac.lockdown_mode_state")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.optional.arm")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.all")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "machdep.cpu.")
  (sysctl-name-prefix "net.routetable.")
)
; V8 (Node.js) thread setup
(allow sysctl-write (sysctl-name "kern.tcsm_enable"))

(allow distributed-notification-post)

; Device files
(allow file-ioctl (literal "/dev/null"))
(allow file-ioctl (literal "/dev/zero"))
(allow file-ioctl (literal "/dev/random"))
(allow file-ioctl (literal "/dev/urandom"))
(allow file-ioctl (literal "/dev/dtracehelper"))
(allow file-ioctl (literal "/dev/tty"))
(allow file-ioctl file-read-data file-write-data
  (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))
; Writing to the inherited stdout/stderr by name (e.g. "> /dev/stderr")
(allow file-write-data (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))
`;

/** The Seatbelt profile for one command. */
export function seatbeltProfile(options: {cwd: string; home: string; tmp: string; policy: SandboxPolicy}): string {
	const {cwd, home, tmp, policy} = options;
	const lines = [BASE_PROFILE];

	lines.push('; Network');
	if (policy.network) {
		lines.push('(allow network*)');
	} else {
		// Servers on this machine (dev servers, test databases) keep working. Binding uses "*:*"
		// because dual-stack sockets bound to 127.0.0.1 appear as ::ffff:127.0.0.1, which Seatbelt's
		// "localhost" doesn't match; binding is local, so this grants no outbound access.
		lines.push('(allow network-bind (local ip "*:*"))');
		lines.push('(allow network-inbound (local ip "*:*"))');
		lines.push('(allow network-outbound (remote ip "localhost:*"))');
	}
	// Local sockets: creating them (Node and Python use socket pairs to talk to child processes), and
	// socket files in the project or your temp folder (test runners, language servers). Sockets
	// elsewhere stay off limits, e.g. the Docker socket or the SSH agent in /private/tmp.
	const socketDirs = [...new Set([cwd, tmp])].map(p => `(subpath ${str(p)})`).join(' ');
	lines.push('(allow system-socket (socket-domain AF_UNIX))');
	lines.push(`(allow network-bind (local unix-socket ${socketDirs}))`);
	lines.push(`(allow network-outbound (remote unix-socket ${socketDirs}))`);

	lines.push('', '; Reads: everything except credentials. Later rules win, so the deny overrides the allow.');
	lines.push('(allow file-read*)');
	lines.push(`(deny file-read* ${SECRET_DIRS.map(d => `(subpath ${str(path.join(home, d))})`).join(' ')})`);

	const writable = [...(policy.writeProject ? [cwd] : []), tmp, '/private/tmp', sandboxCacheDirFor(tmp)];
	lines.push('', '; Writes: the project and temp folders only');
	lines.push(`(allow file-write* ${[...new Set(writable)].map(p => `(subpath ${str(p)})`).join(' ')})`);
	if (policy.writeProject) {
		const protectedFilters = [
			...PROTECTED_IN_PROJECT.subpaths.map(p => `(subpath ${str(path.join(cwd, p))})`),
			...PROTECTED_IN_PROJECT.files.map(p => `(literal ${str(path.join(cwd, p))})`),
		];
		// The same for nested repositories and submodules (.git/modules/<name>/hooks and config).
		const anyGit = `^${regexEscape(cwd)}/(.*/)?\\.git/(.*/)?`;
		protectedFilters.push(`(regex ${str(`${anyGit}hooks(/|$)`)})`, `(regex ${str(`${anyGit}config$`)})`);
		lines.push('; ...except git hooks/config and editor settings, which run code outside the sandbox later');
		lines.push(`(deny file-write* ${protectedFilters.join(' ')})`);
		// Renaming or deleting a .git folder would get around the rule above (move it, edit, move
		// back), and creating one where there is none would let hooks be planted there.
		lines.push(
			`(deny file-write-unlink file-write-create (regex ${str(`^${regexEscape(cwd)}/(.*/)?\\.git$`)}))`,
		);
	}
	return lines.join('\n') + '\n';
}

function sandboxCacheDirFor(tmp: string): string {
	return path.join(tmp, 'tack-sandbox-cache');
}

/** Environment variables that look like credentials; sandboxed commands don't get them. */
export const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/** Environment overrides inside the sandbox: caches that normally live in your home folder. */
export function sandboxEnv(tmp: string): Record<string, string> {
	const cache = sandboxCacheDirFor(tmp);
	return {
		XDG_CACHE_HOME: cache,
		npm_config_cache: path.join(cache, 'npm'),
		GOCACHE: path.join(cache, 'go-build'),
		PIP_CACHE_DIR: path.join(cache, 'pip'),
		TACK_SANDBOX: '1',
	};
}

export type ShellInvocation = {file: string; args: string[]; env: Record<string, string>};

/**
 * How to run a shell command, sandboxed when a policy is given. Pure (no spawning), so it can be
 * tested on any platform.
 */
export function shellInvocation(options: {
	command: string;
	cwd: string;
	shell: string;
	policy: SandboxPolicy | null;
	home?: string;
	tmp?: string;
}): ShellInvocation {
	const {command, shell, policy} = options;
	if (!policy) return {file: shell, args: ['-c', command], env: {}};
	const tmp = options.tmp ?? realTmpDir();
	const profile = seatbeltProfile({cwd: real(options.cwd), home: real(options.home ?? os.homedir()), tmp, policy});
	fs.mkdirSync(sandboxCacheDirFor(tmp), {recursive: true});
	return {file: SANDBOX_EXEC, args: ['-p', profile, shell, '-c', command], env: sandboxEnv(tmp)};
}

/** Signs in command output that the sandbox blocked something. */
const BLOCKED = [
	/operation not permitted/i,
	/permission denied/i,
	/\bEPERM\b/,
	/\bEACCES\b/,
	/could not resolve host/i,
	/nodename nor servname/i,
	/getaddrinfo/i,
	/\bENOTFOUND\b/,
	/network is unreachable/i,
	/failed to connect/i,
	/connection refused/i,
	/read-only file system/i,
];

/** A note for the model when a sandboxed command seems to have been blocked. */
export function sandboxHint(output: string, policy: SandboxPolicy): string {
	if (!BLOCKED.some(re => re.test(output))) return '';
	const limits = policy.writeProject
		? 'it can only write inside the project and temp folders, and has no network access except localhost'
		: 'plan mode is on, so it is read-only and has no network access except localhost';
	const escape = policy.writeProject
		? ' If the command needs more (installing packages, the network, writing elsewhere), run it again with sandbox: false and a reason; the user will be asked to approve.'
		: ' Describe the change in your plan instead; the user can leave plan mode to let you run it.';
	return `\n[This command ran in tack's sandbox: ${limits}.${escape}]`;
}
