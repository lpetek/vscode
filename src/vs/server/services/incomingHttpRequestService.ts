/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { createReadStream, promises as fs, readFileSync } from 'fs';
import { IncomingMessage, Server, ServerResponse } from 'http';
import { join, normalize } from 'path';
import { match, MatchFunction, MatchResult } from 'path-to-regexp';
import { getMediaOrTextMime, PLAIN_TEXT_MIME_TYPE } from 'vs/base/common/mime';
import { UriComponents } from 'vs/base/common/uri';
import { ProtocolConstants } from 'vs/base/parts/ipc/common/ipc.net';
import { refineServiceDecorator } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { editorBackground, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { AbstractIncomingRequestService, IAbstractIncomingRequestService, ParsedRequest } from 'vs/server/services/abstractIncomingRequestService';
import { IEnvironmentServerService } from 'vs/server/services/environmentService';
import { IServerThemeService } from 'vs/server/services/themeService';
import * as Handlebars from 'handlebars';
import { IWorkbenchConfigurationSerialized } from 'vs/platform/workspaces/common/workbench';
import { FileSystemError } from 'vs/workbench/api/common/extHostTypes';

const APP_ROOT = join(__dirname, '..', '..', '..', '..');
const WORKBENCH_PATH = join(APP_ROOT, 'src', 'vs', 'code', 'browser', 'workbench');

const paths = {
	WEBVIEW: join(APP_ROOT, 'out/vs/workbench/contrib/webview/browser/pre'),
	FAVICON: join(APP_ROOT, 'resources', 'web', 'favicon.ico'),
};

/** Matching the given keys in `PollingURLCallbackProvider.QUERY_KEYS` */
const wellKnownKeys = [
	'vscode-requestId',
	'vscode-scheme',
	'vscode-authority',
	'vscode-path',
	'vscode-query',
	'vscode-fragment',
] as const;

type PollingURLQueryKeys = typeof wellKnownKeys[number];

/**
 * See [Web app manifest on MDN](https://developer.mozilla.org/en-US/docs/Web/Manifest) for additional information.
 */
export interface WebManifest {
	name: string;
	short_name: string;
	start_url: string;
	display: string;
	'background-color': string;
	description: string;
	icons: Array<{ src: string; type: string; sizes: string }>;
}

/**
 * A callback response matching the expected value in `PollingURLCallbackProvider`
 */
interface Callback {
	uri: Partial<UriComponents>;
	/** This should be no longer than `PollingURLCallbackProvider.FETCH_TIMEOUT` */
	timeout: NodeJS.Timeout;
}

/**
 * A function which may respond to a request with an possible set of URL params.
 */
export type WebRequestListener<T extends object | null = null> = T extends object
	? (req: ParsedRequest, res: ServerResponse, params: MatchResult<T>['params']) => void | Promise<void>
	: (req: ParsedRequest, res: ServerResponse) => void | Promise<void>;

const matcherOptions = { encode: encodeURI, decode: decodeURIComponent };

/**
 * A nonce used to mark specific inline scripts as secure.
 * @example To use, apply the following attribute:
 * ```html
 * <script nonce="{{CSP_NONCE}}">...</script>
 * ```
 */
const CSP_NONCE = randomBytes(16).toString('base64');

/**
 * Content security policies derived from existing inline Workbench CSPs.
 */
const contentSecurityPolicies: Record<string, string> = {
	'default-src': `'nonce-${CSP_NONCE}'`,
	'manifest-src': `'self'`,
	'img-src': `'self' https: data: blob: vscode-remote-resource:`,
	'media-src': `'none'`,
	'frame-src': `'self' vscode-webview:`,
	'object-src': `'self'`,
	'script-src': `'self' 'nonce-${CSP_NONCE}' 'unsafe-eval' blob:`,
	'style-src': `'self' 'unsafe-inline'`,
	'connect-src': `'self' https: ws:`,
	'font-src': `'self' https: vscode-remote-resource:`,

	'require-trusted-types-for': `'script'`,
	'trusted-types': [
		'TrustedFunctionWorkaround',
		'ExtensionScripts',
		'amdLoader',
		'cellRendererEditorText',
		'defaultWorkerFactory',
		'diffEditorWidget',
		'editorGhostText',
		'domLineBreaksComputer',
		'editorViewLayer',
		'diffReview',
		'extensionHostWorker',
		'insane',
		'notebookRenderer',
		'safeInnerHtml',
		'standaloneColorizer',
		'tokenizeToString',
		'webNestedWorkerExtensionHost'
	].join(' ')
};

function compileTemplate<T = any>(templatePath: string) {
	return Handlebars.compile<T>(readFileSync(templatePath).toString());
}

interface BaseWorkbenchTemplate {
	CLIENT_BACKGROUND_COLOR: string;
	CLIENT_FOREGROUND_COLOR: string;
	CSP_NONCE: string;
}

interface WorkbenchTemplate extends BaseWorkbenchTemplate {
	WORKBENCH_WEB_CONFIGURATION: IWorkbenchConfigurationSerialized;
	WORKBENCH_BUILTIN_EXTENSIONS: Array<never>;
	CLIENT_BACKGROUND_COLOR: string;
	CLIENT_FOREGROUND_COLOR: string;
}

interface WorkbenchErrorTemplate extends BaseWorkbenchTemplate {
	ERROR_HEADER: string;
	ERROR_CODE: string;
	ERROR_MESSAGE: string;
	ERROR_FOOTER: string;
}

interface ClientTheme {
	backgroundColor: string;
	foregroundColor: string;
}

interface RequestHandlerOptions {
	/**
	 * Disables the 404 route handler.
	 * @remark This is especially useful when a parent server is delegating requests.
	 */
	disableFallbackRoute?: boolean
}

export interface IIncomingHTTPRequestService extends IAbstractIncomingRequestService {
	listen(): void;
}

export const IIncomingHTTPRequestService = refineServiceDecorator<IAbstractIncomingRequestService, IIncomingHTTPRequestService>(IAbstractIncomingRequestService);

export class IncomingHTTPRequestService extends AbstractIncomingRequestService<WebRequestListener> implements IIncomingHTTPRequestService {
	private logName = '[Incoming HTTP Service]';

	/** Stored callback URI's sent over from client-side `PollingURLCallbackProvider`. */
	private callbackUriToRequestId = new Map<string, Callback>();

	private templates = {
		workbenchError: compileTemplate<WorkbenchErrorTemplate>(join(WORKBENCH_PATH, 'workbench-error.html')),
		workbenchDev: compileTemplate<WorkbenchTemplate>(join(WORKBENCH_PATH, 'workbench-dev.html')),
		workbenchProd: compileTemplate<WorkbenchTemplate>(join(WORKBENCH_PATH, 'workbench.html')),
		callback: readFileSync(join(APP_ROOT, 'resources', 'web', 'callback.html')).toString(),
	};

	private contentSecurityPolicyHeaderContent = Object
		.keys(contentSecurityPolicies)
		.map((policyName) => `${policyName} ${contentSecurityPolicies[policyName]};`)
		.join(' ');

	protected eventName = 'request';
	/**
	 * Event listener which handles all incoming requests.
	 */
	protected eventListener: WebRequestListener = async (req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');

		try {
			for (const [pattern, handler] of this.routes.entries()) {
				const handled = await this.route(req, res, pattern, handler);

				if (handled) {
					return;
				}
			}
		} catch (error: any) {
			this.logService.error(error);

			return this.serveError(req, res, 500, 'Internal Server Error.');
		}

		const message = `"${req.parsedUrl.pathname}" not found.`;
		const error = FileSystemError.FileNotFound(message);
		if (this.options.disableFallbackRoute) {
			req.emit('error', error);
		} else {
			return this.serveError(req, res, 404, message);
		}
	};

	/**
	 * Attempts to match a route with a given pattern.
	 */
	private route = async (req: ParsedRequest, res: ServerResponse, pattern: MatchFunction, handler: WebRequestListener<any>) => {
		const match = pattern(req.parsedUrl.pathname);

		if (match) {
			await handler(req, res, match.params);
			return true;
		}

		return false;
	};

	/**
	 * PWA manifest file. This informs the browser that the app may be installed.
	 */
	private $webManifest: WebRequestListener = async (req, res) => {
		const { productConfiguration } = await this.environmentService.createWorkbenchWebConfiguration(req);
		const clientTheme = await this.fetchClientTheme();
		const startUrl = req.pathPrefix.substring(
			0,
			req.pathPrefix.lastIndexOf('/') + 1
		);

		const webManifest: WebManifest = {
			name: productConfiguration.nameLong!,
			short_name: productConfiguration.nameShort!,
			start_url: normalize(startUrl),
			display: 'fullscreen',
			'background-color': clientTheme.backgroundColor,
			description: 'Run editors on a remote server.',
			// icons: productConfiguration.icons || [],
			icons: [],
		};

		res.writeHead(200, { 'Content-Type': 'application/manifest+json' });

		return res.end(JSON.stringify(webManifest));
	};

	/**
	 * Static files endpoint.
	 */
	private $static: WebRequestListener<string[]> = async (req, res, params) => {
		return this.serveFile(join(APP_ROOT, params[0]), req, res,);
	};

	/**
	 * Root application endpoint.
	 * @remark This is generally where the server and client interact for the first time.
	 */
	private $root: WebRequestListener = async (req, res) => {
		const webConfigJSON = await this.environmentService.createWorkbenchWebConfiguration(req);
		const { isBuilt } = this.environmentService;
		const clientTheme = await this.fetchClientTheme();

		res.writeHead(200, {
			'Content-Type': 'text/html',
			[isBuilt ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: this.contentSecurityPolicyHeaderContent
		});


		// TODO: investigate auth session for authentication.
		// const authSessionInfo = null;
		const template = this.templates[isBuilt ? 'workbenchProd' : 'workbenchDev'];

		return res.end(template({
			// Inject server-side workbench configuration for client-side workbench.
			WORKBENCH_WEB_CONFIGURATION: webConfigJSON,
			WORKBENCH_BUILTIN_EXTENSIONS: [],
			CLIENT_BACKGROUND_COLOR: clientTheme.backgroundColor,
			CLIENT_FOREGROUND_COLOR: clientTheme.foregroundColor,
			// WORKBENCH_AUTH_SESSION: authSessionInfo ? escapeJSON(authSessionInfo) : '',
			CSP_NONCE,
		})
		);
	};

	/**
 * Web Config endpoint.
 * @remark This can be helpful in debugging a server-side configuration.
 */
	private $webConfig: WebRequestListener = async (req, res) => {
		const webConfigJSON = await this.environmentService.createWorkbenchWebConfiguration(req);

		res.writeHead(200, { 'Content-Type': 'application/json' });

		return res.end(JSON.stringify(webConfigJSON, null, 2));
	};

	/**
	 * Callback endpoint.
	 * @remark The callback cycle is further documented in `PollingURLCallbackProvider`.
	 */
	private $callback: WebRequestListener = async (req, res) => {
		const { parsedUrl } = req;
		const [requestId, vscodeScheme = 'code-oss', vscodeAuthority, vscodePath, vscodeQuery, vscodeFragment] = wellKnownKeys.map(key => {
			const value = parsedUrl.searchParams.get(key);

			return value && value !== null ? decodeURIComponent(value) : undefined;
		});

		if (!requestId) {
			res.writeHead(400, { 'Content-Type': PLAIN_TEXT_MIME_TYPE });
			return res.end('Bad request.');
		}

		// Merge over additional query values that we got.
		let query = new URLSearchParams(vscodeQuery || '');

		for (const key in query.keys()) {
			// Omit duplicate keys within query.
			if (wellKnownKeys.includes(key as PollingURLQueryKeys)) {
				query.delete(key);
			}
		}

		const callback: Callback = {
			uri: {
				scheme: vscodeScheme || 'code-oss',
				authority: vscodeAuthority,
				path: vscodePath,
				query: query.toString(),
				fragment: vscodeFragment,
			},
			// Make sure the map doesn't leak if nothing fetches this URI.
			timeout: setTimeout(() => this.callbackUriToRequestId.delete(requestId), ProtocolConstants.ReconnectionShortGraceTime),
		};

		// Add to map of known callbacks.
		this.callbackUriToRequestId.set(requestId, callback);

		res.writeHead(200, { 'Content-Type': 'text/html' });
		return res.end(this.templates.callback);
	};

	/**
	 * Fetch callback endpoint.
	 * @remark This is the follow up to a client's initial `/callback` lifecycle.
	 */
	private $fetchCallback: WebRequestListener = (req, res) => {
		const requestId = req.parsedUrl.searchParams.get('vscode-requestId');
		if (!requestId) {
			res.writeHead(400, { 'Content-Type': PLAIN_TEXT_MIME_TYPE });
			return res.end(`Bad request.`);
		}

		const knownCallback = this.callbackUriToRequestId.get(requestId);

		if (knownCallback) {
			this.callbackUriToRequestId.delete(requestId);
			clearTimeout(knownCallback.timeout);
		}

		res.writeHead(200, { 'Content-Type': 'text/json' });
		return res.end(JSON.stringify(knownCallback?.uri));
	};

	/**
	 * Remote resource endpoint.
	 * @remark Used to load resources on the client-side. See `FileAccessImpl` for details.
	 */
	private $remoteResource: WebRequestListener = async (req, res) => {
		const path = req.parsedUrl.searchParams.get('path');

		if (path) {
			res.setHeader('Content-Type', getMediaOrTextMime(path) || PLAIN_TEXT_MIME_TYPE);
			res.end(await fs.readFile(path));
		}
	};

	/**
	 * Webview endpoint
	 */
	private $webview: WebRequestListener<string[]> = async (req, res, params) => {
		return this.serveFile(join(paths.WEBVIEW, params[0]), req, res);
	};

	/**
	 * @TODO Consider replacing with FileService.
	 */
	serveFile = async (filePath: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const responseHeaders = Object.create(null);

		try {
			// Sanity checks
			filePath = normalize(filePath); // ensure no "." and ".."

			const stat = await fs.stat(filePath);

			// Check if file modified since
			// Weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`;
			if (req.headers['if-none-match'] === etag) {
				res.writeHead(304);
				return res.end();
			}

			// Headers
			responseHeaders['Content-Type'] = getMediaOrTextMime(filePath) || PLAIN_TEXT_MIME_TYPE;
			responseHeaders['Etag'] = etag;

			res.writeHead(200, responseHeaders);

			// Data
			createReadStream(filePath).pipe(res);
		} catch (error: any) {
			this.logService.error(error.toString());
			responseHeaders['Content-Type'] = PLAIN_TEXT_MIME_TYPE;
			res.writeHead(404, responseHeaders);
			return res.end('Not found');
		}
	};

	serveError = async (req: ParsedRequest, res: ServerResponse, code: number, message: string): Promise<void> => {
		this.logService.debug(`[${req.parsedUrl.toString()}] ${code}: ${message}`);

		const { applicationName, commit, version } = this.environmentService;

		res.statusCode = code;
		res.statusMessage = message;

		if (req.parsedUrl.pathname.endsWith('.json')) {
			res.setHeader('Content-Type', 'application/json');

			res.end(JSON.stringify({ code, message }));
			return;
		}

		const template = this.templates.workbenchError;
		const clientTheme = await this.fetchClientTheme();

		res.setHeader('Content-Type', 'text/html');
		res.end(template({
			ERROR_HEADER: `${applicationName}`,
			ERROR_CODE: code.toString(),
			ERROR_MESSAGE: message,
			ERROR_FOOTER: `${version} — ${commit}`,
			CSP_NONCE,
			CLIENT_BACKGROUND_COLOR: clientTheme.backgroundColor,
			CLIENT_FOREGROUND_COLOR: clientTheme.foregroundColor,
		}));
	};


	public override dispose() {
		super.dispose();

		this.callbackUriToRequestId.forEach(({ timeout }) => clearTimeout(timeout));
		this.callbackUriToRequestId.clear();
	}

	private async fetchClientTheme(): Promise<ClientTheme> {
		const theme = await this.themeService.fetchColorThemeData();

		return {
			backgroundColor: theme.getColor(editorBackground, true)!.toString(),
			foregroundColor: theme.getColor(editorForeground, true)!.toString(),
		};
	}

	/**
	 * Publically available routes.
	 * @remark The order of entry defines a route's priority.
	 */
	private readonly routes: Map<MatchFunction, WebRequestListener<any>>;
	private themeService: IServerThemeService;

	constructor(
		netServer: Server,
		themeService: IServerThemeService,
		environmentService: IEnvironmentServerService,
		logService: ILogService,
		private options: RequestHandlerOptions = {},
	) {
		super(netServer, environmentService, logService);
		this.themeService = themeService;
		const { isBuilt } = this.environmentService;

		Handlebars.registerHelper('toJSON', obj => {
			// Pretty print in development.
			return JSON.stringify(obj, null, isBuilt ? undefined : 2);
		});

		const routePairs: readonly RoutePair[] = [
			['/manifest.webmanifest', this.$webManifest],
			// Legacy browsers.
			['/manifest.json', this.$webManifest],
			['/favicon.ico', this.serveFile.bind(this, paths.FAVICON)],
			['/static/(.*)', this.$static],
			['/webview/(.*)', this.$webview],
			['/', this.$root],
			['/.json', this.$webConfig],
			['/callback', this.$callback],
			['/fetch-callback', this.$fetchCallback],
			['/vscode-remote-resource', this.$remoteResource],
		];

		this.logService.debug(this.logName, 'Listening for the following routes:');

		for (const [pattern] of routePairs) {
			this.logService.debug(this.logName, pattern);
		}

		this.routes = new Map(routePairs.map(([pattern, handler]) => [match(pattern, matcherOptions), handler]));

	}
}

type RoutePair = readonly [string, WebRequestListener<any>];
