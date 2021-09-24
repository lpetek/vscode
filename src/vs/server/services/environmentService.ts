/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { Schemas } from 'vs/base/common/network';
import { URI } from 'vs/base/common/uri';
import { NativeEnvironmentService } from 'vs/platform/environment/node/environmentService';
import { getLogLevel } from 'vs/platform/log/common/log';
import { toWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { getLocaleFromConfig, getCachedNlsConfiguration } from 'vs/workbench/services/extensions/node/nls';
import { IWebWorkspace, IWorkbenchConfigurationSerialized } from 'vs/platform/workspaces/common/workbench';
import { memoize } from 'vs/base/common/decorators';
import { Writeable } from 'vs/base/common/types';
import { NativeParsedArgs } from 'vs/platform/environment/common/argv';
import { INativeEnvironmentService } from 'vs/platform/environment/common/environment';
import { refineServiceDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IProductService } from 'vs/platform/product/common/productService';
import { ParsedRequest } from '../net/abstractNetRequestHandler';
import { IProductConfiguration } from 'vs/base/common/product';
import { NLSConfiguration } from 'vs/base/node/languagePacks';

export interface IEnvironmentServerService extends INativeEnvironmentService {
	readonly serverUrl: URL;
	readonly extensionEnabledProposedApi: string[] | undefined;
	createWorkbenchWebConfiguration: (req: ParsedRequest) => Promise<IWorkbenchConfigurationSerialized>;
	nlsConfigurationPromise: Promise<NLSConfiguration>
}

export const IEnvironmentServerService = refineServiceDecorator<INativeEnvironmentService, IEnvironmentServerService>(INativeEnvironmentService);

export interface IEnvironmentServerServiceConfiguration {
	readonly serverUrl: URL;
	readonly disableUpdateCheck: boolean;
}

/**
 * Static portions of the workbench web configuration.
 * @remark This can be used to cache portions of the config which do not change
 * between client-side requests.
 */
type IStaticWorkbenchWebConfiguration = Omit<IWorkbenchConfigurationSerialized,
	| 'webviewEndpoint'
	| 'productConfiguration'
	| 'workspace'
	| 'remoteUserDataUri'
	| 'remoteAuthority'>;

/**
 * The `EnvironmentServerService` is fairly similar to the Electron specific
 * `EnvironmentMainService`. However, it's capable of creating a web specific workbench.
 */
export class EnvironmentServerService extends NativeEnvironmentService implements IEnvironmentServerService {
	constructor(args: NativeParsedArgs, productService: IProductService, private configuration: IEnvironmentServerServiceConfiguration) {
		super(args, productService);
	}

	/**
	 * Creates the workbench options which are then injected into the front-end.
	 * @remark When passing data to the front-end, this should be your main point of entry,
	 * even extending `IWorkbenchWebConfiguration` if truly necessary.
	 * @remark Only append dynamic properties here.
	 * Static properties should be inherited `staticWorkbenchWebConfiguration`
	 */
	public async createWorkbenchWebConfiguration(req: ParsedRequest): Promise<IWorkbenchConfigurationSerialized> {
		const { productService, workspaceArgPaths } = this;
		const remoteAuthority = req.headers.host;

		if (!remoteAuthority) {
			throw new Error('Expected host in request headers to determine remote authority');
		}

		// Workspace
		const workspaceSearchParamPaths = req.parsedUrl.searchParams.getAll('folder');
		const workspace = this.parseWorkspace(workspaceSearchParamPaths.length ? workspaceSearchParamPaths : workspaceArgPaths, remoteAuthority);

		// TODO: Investigate if base is still necessary.
		const logoutEndpointUrl = this.createRequestUrl(req, '/logout');
		logoutEndpointUrl.searchParams.set('base', req.pathPrefix);

		const productConfiguration: Writeable<IProductConfiguration> = {
			...productService,

			// Endpoints
			logoutEndpointUrl: logoutEndpointUrl.toString(),
			webEndpointUrl: this.createRequestUrl(req, '/static').toString(),

			icons: [
				{
					src: this.createRequestUrl(req, '/static/src/browser/media/pwa-icon-192.png').toString(),
					type: 'image/png',
					sizes: '192x192',
				},
				{
					src: this.createRequestUrl(req, '/static/src/browser/media/pwa-icon-512.png').toString(),
					type: 'image/png',
					sizes: '512x512',
				},
			],
		};

		if (!this.configuration.disableUpdateCheck) {
			productConfiguration.updateUrl = path.join(req.pathPrefix, '/update/check');
		}

		const staticWorkbenchWebConfig = await this.staticWorkbenchWebConfigurationPromise;

		return {
			...staticWorkbenchWebConfig,
			...workspace,
			remoteAuthority,
			webviewEndpoint: this.createRequestUrl(req, '/webview').toString(),
			productConfiguration,
			workspaceProvider: {
				...staticWorkbenchWebConfig.workspaceProvider,
				workspace,
			},
		};
	}

	/**
	 * An aggressively cached portion of the workbench web configuration
	 * @remark Only append static properties here.
	 * Dynamic properties should be applied in `createWorkbenchWebConfiguration`
	 */
	@memoize
	private get staticWorkbenchWebConfigurationPromise() {
		return new Promise<IStaticWorkbenchWebConfiguration>(async resolve => {
			resolve({
				workspaceProvider: {
					payload: [
						['userDataPath', this.userDataPath],
						['enableProposedApi', JSON.stringify(this.extensionEnabledProposedApi || [])],
					],
				},
				developmentOptions: {
					logLevel: getLogLevel(this),
				},
				nlsConfiguration: await this.nlsConfigurationPromise,
			});
		});
	}

	@memoize
	public get nlsConfigurationPromise() {
		return new Promise<NLSConfiguration>(async (resolve) => {
			const locale = this.args.locale || (await getLocaleFromConfig(this.userDataPath));

			resolve(getCachedNlsConfiguration(locale, this.userDataPath, this.commit));
		});
	}

	/**
	 * A convenience method which creates a URL prefixed with a relative path.
	 */
	private createRequestUrl({ pathPrefix, parsedUrl }: ParsedRequest, pathname: string): URL {
		return new URL(path.join('/', pathPrefix, pathname), `${parsedUrl.protocol}//${parsedUrl.host}`);
	}

	/**
	 * A workspace to open in the workbench can either be:
	 * - a workspace file with 0-N folders (via `workspaceUri`)
	 * - a single folder (via `folderUri`)
	 * - empty (via `undefined`)
	 */
	private parseWorkspace(workbenchPaths: string[], remoteAuthority: string): IWebWorkspace | undefined {
		/** @TODO `startPath` should eventually be merged with the parsed path arg. */
		//  const workbenchPaths: string[] = startPath ? [startPath.url] : this.args._.slice(1);

		if (!workbenchPaths.length) {
			return;
		}

		const workbenchURIs = workbenchPaths.map(path =>
			toWorkspaceFolder(
				URI.from({
					scheme: Schemas.vscodeRemote,
					authority: remoteAuthority,
					path,
				}),
			),
		);

		// TODO: multiple workbench entries needs further testing.
		// const hasSingleEntry = workbenchURIs.length > 0;
		// const isSingleEntry = workbenchURIs.length === 1;
		return {
			// workspaceUri: isSingleEntry ? undefined : fs.stat(path),
			workspaceUri: undefined,
			folderUri: workbenchURIs[0].uri.toJSON(),
		};
	}

	@memoize
	public get serverUrl(): URL {
		return this.configuration.serverUrl;
	}

	@memoize
	public get commit(): string {
		return this.productService.commit || 'development';
	}

	@memoize
	public override get isBuilt(): boolean {
		return this.commit !== 'development';
	}

	@memoize
	public get disableUpdateCheck(): boolean {
		return this.configuration.disableUpdateCheck;
	}

	@memoize
	public get environmentPaths(): string[] {
		return [this.extensionsPath, this.logsPath, this.globalStorageHome.fsPath, this.workspaceStorageHome.fsPath, ...this.extraExtensionPaths, ...this.extraBuiltinExtensionPaths];
	}

	@memoize
	get extensionEnabledProposedApi(): string[] | undefined {
		if (Array.isArray(this.args['enable-proposed-api'])) {
			return this.args['enable-proposed-api'];
		}

		if ('enable-proposed-api' in this.args) {
			return [];
		}

		return undefined;
	}

	/**
	 * Workspace paths provided as CLI arguments.
	 */
	@memoize
	private get workspaceArgPaths(): string[] {
		return this.args._.slice(1);
	}

	@memoize
	public get piiPaths(): string[] {
		return [
			path.join(this.userDataPath, 'clp'), // Language packs.
			this.appRoot,
			this.extensionsPath,
			this.builtinExtensionsPath,
			...this.extraExtensionPaths,
			...this.extraBuiltinExtensionPaths,
		];
	}
}
