import { ChildProcess, fork, SendHandle } from 'child_process';
import { VSBuffer } from 'vs/base/common/buffer';
import { FileAccess } from 'vs/base/common/network';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { DebugMessage, IRemoteExtensionHostStartParams } from 'vs/platform/remote/common/remoteAgentConnection';
import { AbstractConnection } from 'vs/server/connection/abstractConnection';
import { getNlsConfiguration } from 'vs/server/nls';
import { ServerProtocol } from 'vs/server/protocol';
import { IExtHostMessage } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import * as objects from 'vs/base/common/objects';
import { NLSConfiguration } from 'vs/base/node/languagePacks';
import { parseExtensionDevOptions } from 'vs/workbench/services/extensions/common/extensionDevOptions';
import * as platform from 'vs/base/common/platform';
import { findFreePort } from 'vs/base/node/ports';

export interface ForkEnvironmentVariables {
	VSCODE_AMD_ENTRYPOINT: string;
	/** One or the other. */
	VSCODE_EXTHOST_WILL_SEND_SOCKET?: boolean;
	VSCODE_IPC_HOOK_EXTHOST?: string;
	VSCODE_HANDLES_UNCAUGHT_ERRORS: boolean;
	VSCODE_LOG_LEVEL?: string;
	VSCODE_LOG_NATIVE: boolean;
	VSCODE_LOG_STACK: boolean;
	VSCODE_NLS_CONFIG: NLSConfiguration;
	VSCODE_PARENT_PID: string;
	VSCODE_PIPE_LOGGING: boolean;
	VSCODE_VERBOSE_LOGGING: boolean;
}

const consoleLogPrefix = '[Extension Host]';

interface DisconnectedMessage {
	type: 'VSCODE_EXTHOST_DISCONNECTED';
}

interface ConsoleMessage {
	type: '__$console';
	// See bootstrap-fork.js#L135.
	severity: 'log' | 'warn' | 'error';
	arguments: any[];
}

type ExtHostMessage = DisconnectedMessage | ConsoleMessage | IExtHostMessage;

export class ExtensionHostConnection extends AbstractConnection {
	private process?: ChildProcess;

	/** @TODO Document usage. */
	public readonly _isExtensionDevHost: boolean;
	public readonly _isExtensionDevDebug: boolean;
	public readonly _isExtensionDevDebugBrk: boolean;
	public readonly _isExtensionDevTestFromCli: boolean;

	public constructor(
		protocol: ServerProtocol,
		private readonly startParams: IRemoteExtensionHostStartParams,
		private readonly _environmentService: INativeEnvironmentService,
	) {
		super(protocol, 'exthost');

		const devOpts = parseExtensionDevOptions(this._environmentService);
		this._isExtensionDevHost = devOpts.isExtensionDevHost;
		this._isExtensionDevDebug = devOpts.isExtensionDevDebug;
		this._isExtensionDevDebugBrk = devOpts.isExtensionDevDebugBrk;
		this._isExtensionDevTestFromCli = devOpts.isExtensionDevTestFromCli;

		protocol.sendMessage(this.debugMessage);

		const buffer = protocol.readEntireBuffer();

		// protocol.dispose();
		// Pause reading on the socket until we have a chance to forward its data.
		protocol.getSendHandle().pause();

		this.spawn(buffer).then((p) => this.process = p);
	}

	private get debugMessage(): DebugMessage {
		return {
			type: 'debug',
			debugPort: typeof this.startParams.port === 'number' ? this.startParams.port : undefined
		};
	}

	/**
	 * Find a free port if extension host debugging is enabled.
	 */
	private async _tryFindDebugPort(): Promise<number> {
		if (typeof this._environmentService.debugExtensionHost.port !== 'number') {
			return 0;
		}

		const expected = this.startParams.port || this._environmentService.debugExtensionHost.port;
		const port = await findFreePort(expected, 10 /* try 10 ports */, 5000 /* try up to 5 seconds */);

		if (!this._isExtensionDevTestFromCli) {
			if (!port) {
				console.warn('%c[Extension Host] %cCould not find a free port for debugging', 'color: blue', 'color:');
			} else {
				if (port !== expected) {
					console.warn(`%c[Extension Host] %cProvided debugging port ${expected} is not free, using ${port} instead.`, 'color: blue', 'color:');
				}
				if (this._isExtensionDevDebugBrk) {
					console.warn(`%c[Extension Host] %cSTOPPED on first line for debugging on port ${port}`, 'color: blue', 'color:');
				} else {
					console.info(`%c[Extension Host] %cdebugger listening on port ${port}`, 'color: blue', 'color:');
				}
			}
		}

		return port || 0;
	}

	protected doDispose(): void {
		this.protocol.destroy();
		if (this.process) {
			this.process.kill();
		}
	}

	protected doReconnect(protocol: ServerProtocol): void {
		this.protocol.beginAcceptReconnection(protocol.getSocket(), protocol.readEntireBuffer());
		this.protocol.endAcceptReconnection();

		protocol.sendMessage(this.debugMessage);
		this.sendInitMessage(protocol.readEntireBuffer());
	}

	private sendIPCMessage(message: IExtHostMessage, sendHandle?: SendHandle) {
		if (!this.process) {
			throw new Error(`Tried to send IPC message without process: ${message.type}`);
		}

		return this.process.send(message, sendHandle);
	}

	private sendInitMessage(buffer: VSBuffer, inflateBytes?: Uint8Array): void {
		this.logger.debug('Sending socket');

		this.sendIPCMessage({
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: Buffer.from(buffer.buffer).toString('base64'),
			skipWebSocketFrames: this.protocol.skipWebSocketFrames,
			permessageDeflate: this.protocol.permessageDeflate,
			inflateBytes: inflateBytes ? Buffer.from(inflateBytes).toString('base64') : '',
		}, this.protocol.getSendHandle());
	}

	private async spawn(buffer: VSBuffer, inflateBytes?: Uint8Array): Promise<ChildProcess> {
		this.logger.debug('Getting NLS configuration...');
		const config = await getNlsConfiguration(this.startParams.language, this._environmentService.userDataPath);

		this.logger.debug('Spawning extension host...');

		const forkEnvs: ForkEnvironmentVariables = {
			VSCODE_AMD_ENTRYPOINT: 'vs/workbench/services/extensions/node/extensionHostProcess',
			VSCODE_PIPE_LOGGING: true,
			VSCODE_VERBOSE_LOGGING: true,
			VSCODE_EXTHOST_WILL_SEND_SOCKET: true,
			VSCODE_HANDLES_UNCAUGHT_ERRORS: true,
			VSCODE_LOG_STACK: false,
			VSCODE_LOG_LEVEL: this._environmentService.verbose ? 'trace' : (this._environmentService.logLevel || process.env.LOG_LEVEL),
			VSCODE_NLS_CONFIG: config,
			VSCODE_PARENT_PID: String(process.pid),
			VSCODE_LOG_NATIVE: this._isExtensionDevHost,
		};

		const env = objects.mixin(process.env, forkEnvs);

		if (platform.isMacintosh) {
			// Unset `DYLD_LIBRARY_PATH`, as it leads to extension host crashes
			// See https://github.com/microsoft/vscode/issues/104525
			delete env['DYLD_LIBRARY_PATH'];
		}

		if (this._isExtensionDevHost) {
			// Unset `VSCODE_CODE_CACHE_PATH` when developing extensions because it might
			// be that dependencies, that otherwise would be cached, get modified.
			delete env['VSCODE_CODE_CACHE_PATH'];
		}

		const opts = {
			env,
			// We only detach the extension host on windows. Linux and Mac orphan by default
			// and detach under Linux and Mac create another process group.
			// We detach because we have noticed that when the renderer exits, its child processes
			// (i.e. extension host) are taken down in a brutal fashion by the OS
			detached: !!platform.isWindows,
			execArgv: undefined as string[] | undefined,
			silent: true
		};

		const portNumber = await this._tryFindDebugPort();

		if (portNumber !== 0) {
			opts.execArgv = [
				'--nolazy',
				(this._isExtensionDevDebugBrk ? '--inspect-brk=' : '--inspect=') + portNumber
			];
		} else {
			opts.execArgv = ['--inspect-port=0'];
		}

		if (this._environmentService.args['prof-v8-extensions']) {
			opts.execArgv.unshift('--prof');
		}

		if (this._environmentService.args['max-memory']) {
			opts.execArgv.unshift(`--max-old-space-size=${this._environmentService.args['max-memory']}`);
		}

		// Run Extension Host as fork of current process
		const extensionHostProcess = fork(FileAccess.asFileUri('bootstrap-fork', require).fsPath, ['--type=extensionHost', '--skipWorkspaceStorageLock'], opts);

		extensionHostProcess.on('error', (error) => {
			this.logger.error('Exited unexpectedly', error.message);
			this.dispose();
		});

		extensionHostProcess.on('exit', (code) => {
			this.logger.debug('Exited', code);
			this.dispose();
		});

		if (extensionHostProcess.stdout && extensionHostProcess.stderr) {
			extensionHostProcess.stdout.setEncoding('utf8').on('data', (d) => this.logger.info(d));
			extensionHostProcess.stderr.setEncoding('utf8').on('data', (d) => this.logger.error(d));
		}

		extensionHostProcess.on('message', (event: ExtHostMessage) => {
			switch (event.type) {
				case '__$console':
					switch (event.severity) {
						case 'log':
							this.logger.info(consoleLogPrefix, event.arguments);
							break;
						case 'warn':
							this.logger.warn(consoleLogPrefix, event.arguments);
							break;
						default:
							this.logger.error(consoleLogPrefix, event.arguments);
					}
					break;
				case 'VSCODE_EXTHOST_DISCONNECTED':
					this.logger.debug('Got disconnected message');
					this.setOffline();
					break;
				case 'VSCODE_EXTHOST_IPC_READY':
					// The
					this.logger.info('Handshake completed');
					this.sendInitMessage(buffer, inflateBytes);
					break;
				default:
					this.logger.error('Unexpected message', event);
					break;
			}
		});

		this.logger.debug('Waiting for handshake...');

		return extensionHostProcess;
	}
}
