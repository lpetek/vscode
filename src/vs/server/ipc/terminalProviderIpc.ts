/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { Emitter, Event } from 'vs/base/common/event';
import { IDisposable } from 'vs/base/common/lifecycle';
import { cloneAndChange } from 'vs/base/common/objects';
import { IProcessEnvironment } from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { IURITransformer, transformIncomingURIs } from 'vs/base/common/uriIpc';
import { findEvent, findEventHandler, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { createRandomIPCHandle } from 'vs/base/parts/ipc/node/ipc.net';
import { getConfigurationValue } from 'vs/platform/configuration/common/configuration';
import { ILogService } from 'vs/platform/log/common/log';
import product from 'vs/platform/product/common/product';
import { RemoteAgentConnectionContext } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IPtyService, IShellLaunchConfig, ITerminalEnvironment } from 'vs/platform/terminal/common/terminal';
import { toWorkspaceFolder, Workspace } from 'vs/platform/workspace/common/workspace';
import { VariableResolverService } from 'vs/server/services/variableResolverService';
import { createServerURITransformer } from 'vs/server/uriTransformer';
import { SimpleConfigProvider } from 'vs/workbench/api/common/extHostConfiguration';
import { CLIServerBase } from 'vs/workbench/api/node/extHostCLIServer';
import { IEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariable';
import { MergedEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableCollection';
import { deserializeEnvironmentVariableCollection } from 'vs/workbench/contrib/terminal/common/environmentVariableShared';
import * as terminal from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import * as terminalEnvironment from 'vs/workbench/contrib/terminal/common/terminalEnvironment';
import { IUriIdentityService } from 'vs/workbench/services/uriIdentity/common/uriIdentity';

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error?: Error) => void;
	uriTransformer: IURITransformer
}

interface RemoteCommand {
	reqId: number, commandId: string, commandArgs: any[]
}

/**
 * @remark See `RemoteTerminalChannel#sendCommandResult`
 */
type SendCommandResult = terminal.RemoteTerminalChannelClient['sendCommandResult'];

/**
 * Server-side equivalent of `RemoteTerminalChannel` and `LocalTerminalService`
 * @remark This class may look like it can be refactored using `ProxyChannel.fromService`
 * however there's enough nuance here that it should be avoided.
 */
export class TerminalProviderChannel implements IServerChannel<RemoteAgentConnectionContext>, IDisposable {
	private readonly _pendingRequests = new Map<number, PendingRequest>();
	private readonly _onExecuteCommand = new Emitter<RemoteCommand>();
	private _lastRequestId = 0;

	/** See `RemoteTerminalChannel#onExecuteCommand` for client-side. */
	private executeCommand(uriTransformer: IURITransformer, commandId: string, args: any[]): Promise<any> {
		return new Promise((resolve, reject) => {
			const reqId = ++this._lastRequestId;

			this._pendingRequests.set(reqId, { resolve, reject, uriTransformer });

			const commandArgs = cloneAndChange(args, value => {
				if (value instanceof URI) {
					return uriTransformer.transformOutgoingURI(value);
				}
				return;
			});

			this._onExecuteCommand.fire({ reqId, commandId, commandArgs });
		});
	}

	public constructor(
		private readonly uriIdentityService: IUriIdentityService,
		private readonly ptyService: IPtyService,
		private readonly logService: ILogService,
	) { }

	private logPrefix = '[TerminalProviderChannel]';

	public listen(context: RemoteAgentConnectionContext, eventName: string, args: any): Event<any> {
		this.logService.debug(this.logPrefix, '[listen]', eventName, args);

		if (eventName === '$onExecuteCommand') {
			return this._onExecuteCommand.event;
		}

		const event = findEvent(this.ptyService, eventName);

		if (!event) {
			this.logService.warn(this.logPrefix, '[listen]', 'Unknown event:', eventName);
			return Event.None;
		}

		return event;
	}

	public async call(context: RemoteAgentConnectionContext, command: string, args: any): Promise<any> {
		this.logService.debug(this.logPrefix, 'call', command, args);

		if (command === '$createProcess') {
			return this.createProcess(context.remoteAuthority, args);
		}

		if (command === '$sendCommandResult') {
			return this.sendCommandResult(...(args as Parameters<SendCommandResult>));
		}

		const eventHandler = findEventHandler(this.ptyService, command);

		if (!eventHandler) {
			throw new Error(`Invalid call '${command}'`);
		}

		return Array.isArray(args)
			? eventHandler.apply(this.ptyService, args)
			: eventHandler.call(this.ptyService, args);
	}

	/**
	 * @references vs/workbench/api/node/extHostTerminalService.ts
	 * @references vsworkbench/contrib/terminal/browser/terminalProcessManager.ts
	 */
	private async createProcess(remoteAuthority: string, terminalArgs: terminal.ICreateTerminalProcessArguments): Promise<terminal.ICreateTerminalProcessResult> {
		const {
			shellLaunchConfig: shellLaunchConfigDto,
			resolvedVariables,
			configuration,
			activeFileResource,
			resolverEnv,
		} = terminalArgs;

		const uriTransformer = createServerURITransformer(remoteAuthority);

		const cliServer = new CLIServerBase(
			{
				executeCommand: (id, ...args) => this.executeCommand(uriTransformer, id, args),
			},
			this.logService,
			createRandomIPCHandle()
		);

		const processEnv: IProcessEnvironment = {
			...process.env,
			...(resolverEnv || {}),
			VSCODE_IPC_HOOK_CLI: cliServer.ipcHandlePath,
		};

		const activeWorkspaceFolder = terminalArgs.activeWorkspaceFolder
			? toWorkspaceFolder(URI.revive(terminalArgs.activeWorkspaceFolder.uri))
			: undefined;

		const workspace = new Workspace(
			terminalArgs.workspaceId,
			terminalArgs.workspaceFolders.map((folderData) => toWorkspaceFolder(URI.revive(folderData.uri))),
			null,
			uri => this.uriIdentityService.extUri.ignorePathCasing(uri));


		const configurationResolverService = new VariableResolverService(
			new SimpleConfigProvider(resolvedVariables),
			workspace,
			URI.revive(activeFileResource),
			processEnv
		);
		const variableResolver = terminalEnvironment.createVariableResolver(activeWorkspaceFolder, process.env, configurationResolverService);

		/**
		 * @reference `BaseExtHostTerminalService#acceptTerminalOpened`
		 */
		const resolvedShellLaunchConfig: IShellLaunchConfig = {
			...shellLaunchConfigDto,
			cwd: typeof shellLaunchConfigDto.cwd === 'string' ? shellLaunchConfigDto.cwd : URI.revive(shellLaunchConfigDto.cwd),
		};

		resolvedShellLaunchConfig.cwd = terminalEnvironment.getCwd(
			resolvedShellLaunchConfig,
			os.homedir(),
			variableResolver,
			activeWorkspaceFolder?.uri,
			configuration['terminal.integrated.cwd'],
			this.logService,
		);

		const settingName = terminalEnvironment.getShellSettingName('shell');
		const envConfig = getConfigurationValue<ITerminalEnvironment | undefined>(configuration, settingName);

		const env = terminalEnvironment.createTerminalEnvironment(
			resolvedShellLaunchConfig,
			envConfig,
			variableResolver,
			product.version,
			configuration['terminal.integrated.detectLocale'],
			{
				...(await this.ptyService.getEnvironment()),
				...processEnv
			}
		);

		// Apply extension environment variable collections to the environment.
		if (!resolvedShellLaunchConfig.strictEnv) {
			// They come in an array and in serialized format.
			const envVariableCollections = new Map<string, IEnvironmentVariableCollection>();
			for (const [k, v] of terminalArgs.envVariableCollections) {
				envVariableCollections.set(k, { map: deserializeEnvironmentVariableCollection(v) });
			}
			const mergedCollection = new MergedEnvironmentVariableCollection(envVariableCollections);
			mergedCollection.applyToProcessEnvironment(env);
		}

		const persistentTerminalId = await this.ptyService.createProcess(
			resolvedShellLaunchConfig,
			resolvedShellLaunchConfig.cwd,
			terminalArgs.cols,
			terminalArgs.rows,
			'11',
			env,
			/** Environment used for `findExecutable` */
			process.env,
			/** windowsEnableConpty */
			false,
			terminalArgs.shouldPersistTerminal,
			terminalArgs.workspaceId,
			terminalArgs.workspaceName,
		);

		this.ptyService.onProcessExit(e => {
			if (e.id === persistentTerminalId) {
				cliServer.dispose();
			}
		});

		return {
			persistentTerminalId,
			resolvedShellLaunchConfig,
		};
	}

	private sendCommandResult: SendCommandResult = async (reqId: number, isError: boolean, payload: any) => {
		const reqData = this._pendingRequests.get(reqId);

		if (!reqData) {
			this.logService.warn(this.logPrefix, `Expected pending command ${reqId}`, { isError });
			return;
		}

		this._pendingRequests.delete(reqId);

		const result = transformIncomingURIs(payload, reqData.uriTransformer);

		return isError ? reqData.reject(result) : reqData.resolve(result);
	};


	public async dispose(): Promise<void> {
		this._pendingRequests.clear();
	}
}
