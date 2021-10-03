import { SendHandle } from 'child_process';
import { VSBuffer } from 'vs/base/common/buffer';
import { Emitter, Event } from 'vs/base/common/event';
import { FileAccess } from 'vs/base/common/network';
import { findFreePort } from 'vs/base/node/ports';
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/common/ipc';
import { PersistentProtocol } from 'vs/base/parts/ipc/common/ipc.net';
import { IIPCOptions } from 'vs/base/parts/ipc/node/ipc.cp';
import { ILogService } from 'vs/platform/log/common/log';
import { DebugMessage, IRemoteExtensionHostStartParams } from 'vs/platform/remote/common/remoteAgentConnection';
import { AbstractConnection } from 'vs/server/connection/abstractConnection';
import { ServerProtocol } from 'vs/server/protocol';
import { IEnvironmentServerService } from 'vs/server/services/environmentService';
import { parseExtensionDevOptions } from 'vs/workbench/services/extensions/common/extensionDevOptions';
import { createMessageOfType, MessageType } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { ExtensionHostKind, IExtensionHost } from 'vs/workbench/services/extensions/common/extensions';
import { ExtensionHostProcess } from 'vs/workbench/services/extensions/node/extensionHost';
import { getCachedNlsConfiguration } from 'vs/workbench/services/extensions/node/nls';

/**
 * @remark Ensure this remains JSON serializable.
 */
export interface ForkEnvironmentVariables {
	/** Specify one or the other. */
	VSCODE_AMD_ENTRYPOINT: string;
	VSCODE_EXTHOST_WILL_SEND_SOCKET: true;

	VSCODE_HANDLES_UNCAUGHT_ERRORS: boolean;
	VSCODE_LOG_LEVEL?: string;
	VSCODE_LOG_NATIVE: boolean;
	VSCODE_LOG_STACK: boolean;
	VSCODE_NLS_CONFIG: string;
	VSCODE_PIPE_LOGGING: boolean;
	VSCODE_VERBOSE_LOGGING: boolean;
	VSCODE_CODE_CACHE_PATH?: string;
}

/**
 * This complements the client-side `PersistantConnection` in `RemoteExtensionHost`.
 * @see `LocalProcessExtensionHost`
 */
export class ExtensionHostConnection extends AbstractConnection implements IExtensionHost {
	public readonly kind = ExtensionHostKind.LocalProcess;
	public readonly remoteAuthority = null;
	public readonly lazyStart = false;
	private _terminating = false;

	private readonly _onExit: Emitter<[number, string]> = new Emitter<[number, string]>();
	public readonly onExit: Event<[number, string]> = this._onExit.event;
	private _messageProtocol: Promise<PersistentProtocol> | null = null;

	private clientProcess?: ExtensionHostProcess;

	/** @TODO Document usage. */
	public readonly _isExtensionDevHost: boolean;
	public readonly _isExtensionDevDebug: boolean;
	public readonly _isExtensionDevTestFromCli: boolean;

	public constructor(protocol: ServerProtocol, logService: ILogService, private readonly startParams: IRemoteExtensionHostStartParams, private readonly _environmentService: IEnvironmentServerService) {
		super(protocol, logService, 'ExtensionHost');

		const devOpts = parseExtensionDevOptions(this._environmentService);
		this._isExtensionDevHost = devOpts.isExtensionDevHost;
		this._isExtensionDevDebug = devOpts.isExtensionDevDebug;
		this._isExtensionDevTestFromCli = devOpts.isExtensionDevTestFromCli;
	}

	private get debugMessage(): DebugMessage {
		return {
			type: 'debug',
			debugPort: typeof this.startParams.port === 'number' ? this.startParams.port : undefined,
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
			}
		}

		return port || 0;
	}

	/** @TODO implement. */
	public getInspectPort(): number | undefined {
		return undefined;
	}

	/** @TODO implement. */
	public enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}

	protected doDispose(): void {
		this.protocol.dispose();

		this.clientProcess?.dispose();
	}

	protected doReconnect(reconnectionProtocol: ServerProtocol): void {
		this.logService.debug(this.logPrefix, '(Reconnect 1/4)', 'Sending new protocol debug message...');
		reconnectionProtocol.sendMessage(this.debugMessage);

		this.logService.debug(this.logPrefix, '(Reconnect 2/4)', 'Swapping socket references...');

		this.protocol.beginAcceptReconnection(reconnectionProtocol.getSocket(), reconnectionProtocol.readEntireBuffer());
		this.protocol.endAcceptReconnection();

		this.logService.debug(this.logPrefix, '(Reconnect 3/4)', 'Pausing socket until we have a chance to forward its data.');
		const { initialDataChunk, sendHandle } = this.protocol.suspend();

		const messageSent = this.sendInitMessage(initialDataChunk, this.protocol.inflateBytes, sendHandle);

		if (!messageSent) {
			new Error('Child process did not receive init message. Is their a backlog?');
		}

		this.logService.debug(this.logPrefix, '(Reconnect 4/4)', 'Child process received init message!');
	}

	/**
	 * Sends IPC socket to client process.
	 * @remark This is the complement of `extensionHostProcessSetup.ts#_createExtHostProtocol`
	 */
	private sendInitMessage(initialDataChunk: VSBuffer, inflateBytes: VSBuffer, sendHandle: SendHandle): boolean {
		if (!this.clientProcess) {
			throw new Error(`${this.logPrefix} Client process is not set`);
		}

		this.logService.debug(this.logPrefix, 'Sending init message to client process...');

		return this.clientProcess.sendIPCMessage(
			{
				type: 'VSCODE_EXTHOST_IPC_SOCKET',
				initialDataChunk: Buffer.from(initialDataChunk.buffer).toString('base64'),
				skipWebSocketFrames: this.protocol.skipWebSocketFrames,
				permessageDeflate: this.protocol.getSocket().permessageDeflate,
				inflateBytes: inflateBytes ? Buffer.from(inflateBytes.buffer).toString('base64') : '',
			},
			sendHandle,
		);
	}

	private async generateClientOptions(): Promise<IIPCOptions> {
		this.logService.debug('Getting NLS configuration...');
		const nlsConfiguration = await getCachedNlsConfiguration(this.startParams.language, this._environmentService.userDataPath);
		const portNumber = await this._tryFindDebugPort();

		return {
			serverName: 'Server Extension Host',
			freshExecArgv: true,
			debugBrk: this.startParams.break ? portNumber : undefined,
			debug: this.startParams.break ? undefined : portNumber,
			args: ['--type=extensionHost', '--skipWorkspaceStorageLock'],
			env: <ForkEnvironmentVariables>{
				...(this.startParams.env || {}),
				VSCODE_AMD_ENTRYPOINT: 'vs/workbench/services/extensions/node/extensionHostProcess',
				VSCODE_PIPE_LOGGING: true,
				VSCODE_VERBOSE_LOGGING: true,
				/** Extension child process will wait until socket is sent. */
				VSCODE_EXTHOST_WILL_SEND_SOCKET: true,
				VSCODE_HANDLES_UNCAUGHT_ERRORS: true,
				VSCODE_LOG_STACK: false,
				VSCODE_LOG_LEVEL: this._environmentService.verbose ? 'trace' : this._environmentService.logLevel || process.env.LOG_LEVEL,
				VSCODE_NLS_CONFIG: JSON.stringify(nlsConfiguration),
				VSCODE_LOG_NATIVE: this._isExtensionDevHost,
				// Unset `VSCODE_CODE_CACHE_PATH` when developing extensions because it might
				// be that dependencies, that otherwise would be cached, get modified.
				VSCODE_CODE_CACHE_PATH: this._isExtensionDevHost ? undefined : process.env['VSCODE_CODE_CACHE_PATH'],
			},
		};
	}

	private _onExtHostProcessExit(code: number, signal: string): void {
		this.dispose();

		if (code !== 0 && signal !== 'SIGTERM') {
			this.logService.error(`${this.logPrefix} Extension host exited with code: ${code} and signal: ${signal}.`);
		}

		if (this._terminating) {
			// Expected termination path (we asked the process to terminate)
			return;
		}

		this._onExit.fire([code, signal]);
	}

	/**
	 * Creates an extension host child process.
	 * @remark this is very similar to `LocalProcessExtensionHost`
	 */
	public start(): Promise<IMessagePassingProtocol> {
		this._messageProtocol = new Promise(async (resolve, reject) => {
			this.logService.debug(this.logPrefix, '(Spawn 1/7)', 'Sending client initial debug message.');
			this.protocol.sendMessage(this.debugMessage);

			this.logService.debug(this.logPrefix, '(Spawn 2/7)', 'Pausing socket until we have a chance to forward its data.');

			const { initialDataChunk, sendHandle } = this.protocol.suspend();

			this.logService.debug(this.logPrefix, '(Spawn 3/7)', 'Generating IPC client options...');
			const clientOptions = await this.generateClientOptions();

			this.logService.debug(this.logPrefix, '(Spawn 4/7)', 'Starting extension host child process...');
			this.clientProcess = new ExtensionHostProcess(FileAccess.asFileUri('bootstrap-fork', require).fsPath, clientOptions);

			this.clientProcess.onDidProcessExit(([code, signal]) => {
				this._onExtHostProcessExit(code, signal);
			});

			this.clientProcess.onReady(() => {
				this.logService.debug(this.logPrefix, '(Spawn 5/7)', 'Extension host is ready!');
				this.logService.debug(this.logPrefix, '(Spawn 6/7)', 'Sending init message to child process...');
				const messageSent = this.sendInitMessage(initialDataChunk, this.protocol.inflateBytes, sendHandle);

				if (messageSent) {
					this.logService.debug(this.logPrefix, '(Spawn 7/7)', 'Child process received init message!');
					return resolve(this.protocol);
				}

				reject(new Error('Child process did not receive init message. Is their a backlog?'));
			});
		});

		return this._messageProtocol;
	}

	public terminate(): void {
		if (this._terminating) {
			return;
		}
		this._terminating = true;

		this.dispose();

		if (!this._messageProtocol) {
			// .start() was not called
			return;
		}

		this._messageProtocol.then((protocol) => {

			// Send the extension host a request to terminate itself
			// (graceful termination)
			protocol.send(createMessageOfType(MessageType.Terminate));

			protocol.getSocket().dispose();

			protocol.dispose();

			// Give the extension host 10s, after which we will
			// try to kill the process and release any resources
			setTimeout(() => this._cleanResources(), 10 * 1000);

		}, (err) => {
			// Establishing a protocol with the extension host failed, so
			// try to kill the process and release any resources.
			this._cleanResources();
		});
	}

	private _cleanResources(): void {
		if (this.clientProcess) {
			this.clientProcess.dispose();
		}
	}
}
