/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { gracefulify } from 'graceful-fs';
import { createServer as createNetServer, Server as NetServer } from 'http';
import { hostname, release } from 'os';
import * as path from 'path';
import { combinedDisposable, Disposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { IPCServer, IServerChannel, ProxyChannel } from 'vs/base/parts/ipc/common/ipc';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { ConfigurationService } from 'vs/platform/configuration/common/configurationService';
import { ExtensionHostDebugBroadcastChannel } from 'vs/platform/debug/common/extensionHostDebugIpc';
import { ExtensionGalleryService } from 'vs/platform/extensionManagement/common/extensionGalleryService';
import { IExtensionGalleryService, IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { IFileService } from 'vs/platform/files/common/files';
import { FileService } from 'vs/platform/files/common/fileService';
import { DiskFileSystemProvider } from 'vs/platform/files/node/diskFileSystemProvider';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { ILocalizationsService } from 'vs/platform/localizations/common/localizations';
import { LocalizationsService } from 'vs/platform/localizations/node/localizations';
import { BufferLogService } from 'vs/platform/log/common/bufferLog';
import { ConsoleMainLogger, getLogLevel, ILoggerService, ILogService, MultiplexLogService } from 'vs/platform/log/common/log';
import { LogLevelChannel } from 'vs/platform/log/common/logIpc';
import { LoggerService } from 'vs/platform/log/node/loggerService';
import { SpdLogLogger } from 'vs/platform/log/node/spdlogLog';
import product from 'vs/platform/product/common/product';
import { IProductService } from 'vs/platform/product/common/productService';
import { IRequestService } from 'vs/platform/request/common/request';
import { RequestChannel } from 'vs/platform/request/common/requestIpc';
import { RequestService } from 'vs/platform/request/node/requestService';
import { resolveCommonProperties } from 'vs/platform/telemetry/common/commonProperties';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryLogAppender } from 'vs/platform/telemetry/common/telemetryLogAppender';
import { ITelemetryServiceConfig, TelemetryService } from 'vs/platform/telemetry/common/telemetryService';
import { combinedAppender, NullTelemetryService } from 'vs/platform/telemetry/common/telemetryUtils';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/appInsightsAppender';
import ErrorTelemetry from 'vs/platform/telemetry/node/errorTelemetry';
import { IReconnectConstants, LocalReconnectConstants, TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { PtyHostService } from 'vs/platform/terminal/node/ptyHostService';
import { TelemetryClient } from 'vs/server/insights';
import { ExtensionEnvironmentChannel } from 'vs/server/ipc/extensionEnvironmentIpc';
import { FileProviderChannel } from 'vs/server/ipc/fileProviderIpc';
import { TerminalProviderChannel } from 'vs/server/ipc/terminalProviderIpc';
import { LogsDataCleaner } from 'vs/server/logsDataCleaner';
import { INLSExtensionScannerService, NLSExtensionScannerService } from 'vs/server/services/nlsExtensionScannerService';
import { IServerThemeService, ServerThemeService } from 'vs/server/services/serverThemeService';
import { createServerURITransformer } from 'vs/server/uriTransformer';
import { REMOTE_TERMINAL_CHANNEL_NAME } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { IExtensionResourceLoaderService } from 'vs/workbench/services/extensionResourceLoader/common/extensionResourceLoader';
// eslint-disable-next-line code-import-patterns
import { ExtensionResourceLoaderService } from 'vs/workbench/services/extensionResourceLoader/electron-sandbox/extensionResourceLoaderService';
import { REMOTE_FILE_SYSTEM_CHANNEL_NAME } from 'vs/workbench/services/remote/common/remoteAgentFileSystemChannel';
import { RemoteExtensionLogFileName } from 'vs/workbench/services/remote/common/remoteAgentService';
import { toErrorMessage } from '../base/common/errorMessage';
import { setUnexpectedErrorHandler } from '../base/common/errors';
import { getMachineId } from '../base/node/id';
import { IInstantiationService } from '../platform/instantiation/common/instantiation';
import { RemoteAgentConnectionContext } from '../platform/remote/common/remoteAgentEnvironment';
import { WebRequestHandler } from './net/webRequestHandler';
import { WebSocketHandler } from './net/webSocketHandler';
import { EnvironmentServerService, IEnvironmentServerService } from './services/environmentService';

interface IServerProcessMainStartupOptions {
	listenWhenReady?: boolean;
}

interface IServerProcessMain {
	startup(startupOptions: IServerProcessMainStartupOptions): Promise<NetServer>;
}

/**
 * Handles client connections to a editor instance via IPC.
 */
export class ServerProcessMain extends Disposable implements IServerProcessMain {
	constructor(private readonly configuration: CodeServerLib.ServerConfiguration) {
		super();

		// Enable gracefulFs
		gracefulify(fs);

		this.registerListeners();
	}

	private registerListeners(): void {
		process.once('exit', () => this.dispose());
	}

	public async startup({ listenWhenReady = true }: IServerProcessMainStartupOptions = {}): Promise<NetServer> {
		// Services
		const [
			instantiationService,
			environmentServerService,
			logService,
			serverThemeService,
			bufferLogService,
		] = await this.createServices();

		// Net Server
		const netServer = createNetServer();

		const webSocketHandler = instantiationService.createInstance(WebSocketHandler, netServer);
		webSocketHandler.listen();

		const webRequestHandler = instantiationService.createInstance(WebRequestHandler, netServer, serverThemeService);
		webRequestHandler.listen();

		// IPC Server
		const ipcServer = new IPCServer<RemoteAgentConnectionContext>(webSocketHandler.onDidClientConnect);

		// Log info
		logService.trace('Server configuration', JSON.stringify(this.configuration));

		// Channels
		await this.initChannels(instantiationService, ipcServer);

		// Error handler
		this.registerErrorHandler(logService);

		// Delay creation of spdlog for perf reasons (https://github.com/microsoft/vscode/issues/72906)
		bufferLogService.logger = new SpdLogLogger('main', path.join(environmentServerService.logsPath, `${RemoteExtensionLogFileName}.log`), true, bufferLogService.getLevel());

		// Instantiate Contributions
		this._register(combinedDisposable(instantiationService.createInstance(LogsDataCleaner), instantiationService.createInstance(ErrorTelemetry), webRequestHandler, webSocketHandler, ipcServer));

		// Listen for incoming connections
		if (listenWhenReady) {
			const { serverUrl } = this.configuration;

			await listen(netServer, parseInt(serverUrl.port, 10), serverUrl.hostname);
			logService.info('Code Server active and listening at:', serverUrl.toString());
		}

		return netServer;
	}

	// References:
	// ../../electron-browser/sharedProcess/sharedProcessMain.ts#L148
	// ../../../code/electron-main/app.ts
	public async createServices(): Promise<[IInstantiationService, IEnvironmentServerService, ILogService, IServerThemeService, BufferLogService]> {
		const services = new ServiceCollection();

		// Product
		const productService: IProductService = {
			_serviceBrand: undefined,
			...product,
		};

		services.set(IProductService, productService);

		// Environment
		const environmentServerService = new EnvironmentServerService(this.configuration.args, productService, {
			disableUpdateCheck: this.configuration.disableUpdateCheck,
			serverUrl: this.configuration.serverUrl,
		});

		services.set(IEnvironmentServerService, environmentServerService);

		await Promise.all(
			environmentServerService.environmentPaths.map(p =>
				fs.promises.mkdir(p, { recursive: true }).catch(error => {
					console.warn(error.message || error);
				}),
			),
		);

		// Loggers
		// src/vs/code/electron-main/main.ts#142
		const bufferLogService = new BufferLogService();
		const logService = new MultiplexLogService([new ConsoleMainLogger(getLogLevel(environmentServerService)), bufferLogService]);
		process.once('exit', () => logService.dispose());
		services.set(ILogService, logService);

		// Files
		const fileService = new FileService(logService);
		fileService.registerProvider(Schemas.file, new DiskFileSystemProvider(logService));

		const loggerService = new LoggerService(logService, fileService);

		services.set(ILogService, logService);
		services.set(ILoggerService, loggerService);

		// Configuration
		const configurationService = new ConfigurationService(environmentServerService.settingsResource, fileService);
		await configurationService.initialize();
		services.set(IConfigurationService, configurationService);

		// Request
		services.set(IRequestService, new SyncDescriptor(RequestService));

		// File Service can now be set...
		services.set(IFileService, fileService);

		// Configuration
		await configurationService.initialize();
		services.set(IConfigurationService, configurationService);

		// Instantiation
		const instantiationService = new InstantiationService(services);

		// Telemetry
		if (!environmentServerService.isExtensionDevelopment && !environmentServerService.disableTelemetry && productService.enableTelemetry) {
			const machineId = await this.resolveMachineId();

			const appender = combinedAppender(new AppInsightsAppender('code-server', null, () => new TelemetryClient()), new TelemetryLogAppender(loggerService, environmentServerService));

			const commonProperties = resolveCommonProperties(fileService, release(), hostname(), process.arch, environmentServerService.commit, product.version, machineId, undefined, environmentServerService.installSourcePath, 'code-server');

			const config: ITelemetryServiceConfig = { appender, commonProperties, piiPaths: environmentServerService.piiPaths, sendErrorTelemetry: true };

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [config]));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		// Extensions
		services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
		services.set(IExtensionGalleryService, new SyncDescriptor(ExtensionGalleryService));

		const extensionResourceLoaderService = new ExtensionResourceLoaderService(fileService);
		services.set(IExtensionResourceLoaderService, extensionResourceLoaderService);

		const extensionScannerService = new NLSExtensionScannerService(environmentServerService, logService, productService);
		services.set(INLSExtensionScannerService, extensionScannerService);

		// Themes
		const serverThemeService = new ServerThemeService(extensionScannerService, logService, configurationService, extensionResourceLoaderService);
		await serverThemeService.initialize();
		services.set(IServerThemeService, serverThemeService);

		// Localization
		services.set(ILocalizationsService, new SyncDescriptor(LocalizationsService));

		return [
			instantiationService,
			environmentServerService,
			logService,
			serverThemeService,
			bufferLogService,
		];
	}

	private initChannels(instantiationService: IInstantiationService, ipcServer: IPCServer<RemoteAgentConnectionContext>): Promise<void> {
		return new Promise(resolve => {
			instantiationService.invokeFunction(async accessor => {
				const configurationService = accessor.get(IConfigurationService);
				const logService = accessor.get(ILogService);
				const telemetryService = accessor.get(ITelemetryService);
				const extensionManagementService = accessor.get(IExtensionManagementService);
				const environmentServerService = accessor.get(IEnvironmentServerService);
				const nlsExtensionScannerService = accessor.get(INLSExtensionScannerService);
				const localizationsService = accessor.get(ILocalizationsService);
				const requestService = accessor.get(IRequestService);

				ipcServer.registerChannel('logger', new LogLevelChannel(logService));
				ipcServer.registerChannel(ExtensionHostDebugBroadcastChannel.ChannelName, new ExtensionHostDebugBroadcastChannel());

				ipcServer.registerChannel('extensions', new ExtensionManagementChannel(extensionManagementService, context => createServerURITransformer(context.remoteAuthority)));

				ipcServer.registerChannel('remoteextensionsenvironment', new ExtensionEnvironmentChannel(environmentServerService, nlsExtensionScannerService, telemetryService, ''));
				ipcServer.registerChannel('request', new RequestChannel(requestService));
				ipcServer.registerChannel('localizations', <IServerChannel<any>>ProxyChannel.fromService(localizationsService));
				ipcServer.registerChannel(REMOTE_FILE_SYSTEM_CHANNEL_NAME, new FileProviderChannel(environmentServerService, logService));

				const reconnectConstants: IReconnectConstants = {
					graceTime: LocalReconnectConstants.GraceTime,
					shortGraceTime: LocalReconnectConstants.ShortGraceTime,
					scrollback: configurationService.getValue<number>(TerminalSettingId.PersistentSessionScrollback) ?? 100,
					useExperimentalSerialization: configurationService.getValue<boolean>(TerminalSettingId.PersistentSessionExperimentalSerializer) ?? true,
				};

				const ptyHostService = new PtyHostService(reconnectConstants, configurationService, logService, telemetryService);
				ipcServer.registerChannel(REMOTE_TERMINAL_CHANNEL_NAME, new TerminalProviderChannel(logService, ptyHostService));

				resolve();
			});
		});
	}

	private registerErrorHandler(logService: ILogService): void {
		// Install handler for unexpected errors
		setUnexpectedErrorHandler(error => {
			const message = toErrorMessage(error, true);
			if (!message) {
				return;
			}

			logService.error(`[uncaught exception in sharedProcess]: ${message}`);
		});
	}

	// TODO cache machine ID with StateService for faster startup.
	private async resolveMachineId(): Promise<string> {
		return getMachineId();
	}
}

export const listen = (server: NetServer, port: number, host: string) => {
	return new Promise<void>(async (resolve, reject) => {
		server.on('error', reject);

		const onListen = () => {
			// Promise resolved earlier so this is an unrelated error.
			server.off('error', reject);

			resolve();
		};
		// [] is the correct format when using :: but Node errors with them.
		server.listen(port, host.replace(/^\[|\]$/g, ''), onListen);
	});
};
