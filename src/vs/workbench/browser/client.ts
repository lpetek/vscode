/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { localize } from 'vs/nls';
import { MenuId, MenuRegistry } from 'vs/platform/actions/common/actions';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { ContextKeyExpr, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ILogService } from 'vs/platform/log/common/log';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
// eslint-disable-next-line code-import-patterns
import 'vs/workbench/contrib/localizations/browser/localizations.contribution';
import 'vs/workbench/services/localizations/browser/localizationsService';
import type { IProductConfiguration } from 'vs/workbench/workbench.web.api';


/**
 * @file All client-side customization to VS Code should live in this file when
 * possible.
 */

/**
 * This is called by vs/workbench/browser/web.main.ts after the workbench has
 * been initialized so we can initialize our own client-side code.
 */

export class CodeServerClientAdditions extends Disposable {
	static LOGOUT_COMMAND_ID = 'code-server.logout';
	static AUTH_KEY = 'code-server.authed';
	productConfiguration: Partial<IProductConfiguration>;

	constructor(
		productConfiguration: Partial<IProductConfiguration>,
		@ILogService private logService: ILogService,
		@INotificationService private notificationService: INotificationService,
		@IStorageService private storageService: IStorageService,
		@IContextKeyService private contextKeyService: IContextKeyService
	) {
		super();
		this.productConfiguration = productConfiguration;
	}

	async startup(): Promise<void> {
		const { nameShort, updateUrl } = this.productConfiguration;

		// Emit client events
		const event = new CustomEvent('ide-ready');
		window.dispatchEvent(event);

		if (parent) {
			// Tell the parent loading has completed.
			parent.postMessage({ event: 'loaded' }, '*');

			// Proxy or stop proxing events as requested by the parent.
			const listeners = new Map<string, (event: Event) => void>();

			window.addEventListener('message', parentEvent => {
				const eventName = parentEvent.data.bind || parentEvent.data.unbind;
				if (eventName) {
					const oldListener = listeners.get(eventName);
					if (oldListener) {
						document.removeEventListener(eventName, oldListener);
					}
				}

				if (parentEvent.data.bind && parentEvent.data.prop) {
					const listener = (event: Event) => {
						parent?.postMessage(
							{
								event: parentEvent.data.event,
								[parentEvent.data.prop]: event[parentEvent.data.prop as keyof Event],
							},
							window.location.origin,
						);
					};
					listeners.set(parentEvent.data.bind, listener);
					document.addEventListener(parentEvent.data.bind, listener);
				}
			});
		}

		if (!window.isSecureContext) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: `${nameShort} is being accessed over an insecure domain. Web views, the clipboard, and other functionality may not work as expected.`,
				actions: {
					primary: [
						{
							id: 'understand',
							label: 'I understand',
							tooltip: '',
							class: undefined,
							enabled: true,
							checked: true,
							dispose: () => undefined,
							run: () => {
								return Promise.resolve();
							},
						},
					],
				},
			});
		}

		const getUpdate = async (updateCheckEndpoint: string): Promise<void> => {
			this.logService.debug('Checking for update...');

			const response = await fetch(updateCheckEndpoint, {
				headers: { Accept: 'application/json' },
			});
			if (!response.ok) {
				throw new Error(response.statusText);
			}
			const json = await response.json();
			if (json.error) {
				throw new Error(json.error);
			}
			if (json.isLatest) {
				return;
			}

			const lastNoti = this.storageService.getNumber('csLastUpdateNotification', StorageScope.GLOBAL);
			if (lastNoti) {
				// Only remind them again after 1 week.
				const timeout = 1000 * 60 * 60 * 24 * 7;
				const threshold = lastNoti + timeout;
				if (Date.now() < threshold) {
					return;
				}
			}

			this.storageService.store('csLastUpdateNotification', Date.now(), StorageScope.GLOBAL, StorageTarget.MACHINE);

			this.notificationService.notify({
				severity: Severity.Info,
				message: `[Code Server v${json.latest}](https://github.com/cdr/code-server/releases/tag/v${json.latest}) has been released!`,
			});
		};

		const updateLoop = (): void => {
			if (!updateUrl) {
				return;
			}

			getUpdate(updateUrl)
				.catch(error => {
					this.logService.debug(`failed to check for update: ${error}`);
				})
				.finally(() => {
					// Check again every 6 hours.
					setTimeout(updateLoop, 1000 * 60 * 60 * 6);
				});
		};

		updateLoop();

		this.appendSessionCommands();
	}

	private appendSessionCommands() {
		const { authed, logoutEndpointUrl } = this.productConfiguration;

		// Use to show or hide logout commands and menu options.
		this.contextKeyService.createKey(CodeServerClientAdditions.AUTH_KEY, !!authed);

		CommandsRegistry.registerCommand(CodeServerClientAdditions.LOGOUT_COMMAND_ID, () => {
			if (logoutEndpointUrl) {
				window.location.href = logoutEndpointUrl;
			}
		});

		// Add logout to command palette.
		MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: CodeServerClientAdditions.LOGOUT_COMMAND_ID,
				title: localize('logout', 'Log out'),
			},
			when: ContextKeyExpr.has(CodeServerClientAdditions.AUTH_KEY),
		});

		// Add logout to the (web-only) home menu.
		MenuRegistry.appendMenuItem(MenuId.MenubarHomeMenu, {
			command: {
				id: CodeServerClientAdditions.LOGOUT_COMMAND_ID,
				title: localize('logout', 'Log out'),
			},
			when: ContextKeyExpr.has(CodeServerClientAdditions.AUTH_KEY),
		});
	}
}
