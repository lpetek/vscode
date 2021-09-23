/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { ColorScheme } from 'vs/platform/theme/common/theme';
import { INLSExtensionScannerService } from 'vs/server/services/nlsExtensionScannerService';
import { IExtensionResourceLoaderService } from 'vs/workbench/services/extensionResourceLoader/common/extensionResourceLoader';
import { IExtensionPointUser, ExtensionMessageCollector } from 'vs/workbench/services/extensions/common/extensionsRegistry';
import { ColorThemeData } from 'vs/workbench/services/themes/common/colorThemeData';
import { ThemeConfiguration } from 'vs/workbench/services/themes/common/themeConfiguration';
import { registerColorThemeExtensionPoint, ThemeRegistry } from 'vs/workbench/services/themes/common/themeExtensionPoints';
import { IThemeExtensionPoint } from 'vs/workbench/services/themes/common/workbenchThemeService';

export interface IServerThemeService {
	initialize(): Promise<void>;
	fetchColorThemeData(): Promise<ColorThemeData>;
}

export const IServerThemeService = createDecorator<IServerThemeService>('IServerThemeService');

/**
 * The server theme service allows for limited and readonly access to theme resources.
 * @remark This is not yet as robust as `WorkbenchThemeService`
 */
export class ServerThemeService implements IServerThemeService {
	private colorThemesExtPoint = registerColorThemeExtensionPoint();
	private themeConfiguration = new ThemeConfiguration(this.configurationService);
	private colorThemeRegistry = new ThemeRegistry(this.colorThemesExtPoint, ColorThemeData.fromExtensionTheme);

	constructor(
		@INLSExtensionScannerService private extensionScannerService: INLSExtensionScannerService,
		@ILogService private logService: ILogService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IExtensionResourceLoaderService private extensionResourceLoaderService: IExtensionResourceLoaderService,
	) { }

	async initialize() {
		const extPointName = this.colorThemesExtPoint.name;
		const availableExtensions = await this.extensionScannerService.scanExtensions();

		const users: IExtensionPointUser<IThemeExtensionPoint[]>[] = availableExtensions
			.filter(desc => {
				return desc.contributes && Object.hasOwnProperty.call(desc.contributes, extPointName);
			})
			.map(desc => {
				this.logService.debug('Theme extension found', desc.name);

				return {
					description: desc,
					value: desc.contributes![extPointName as keyof typeof desc.contributes] as IThemeExtensionPoint[],
					collector: new ExtensionMessageCollector(() => { }, desc, extPointName)
				};
			});

		this.colorThemesExtPoint.acceptUsers(users);
	}

	/**
	 * Returns the color data from a user's currently active theme.
	 * @remark If the theme is not found, a default will be provided.
	 */
	async fetchColorThemeData(): Promise<ColorThemeData> {
		const currentThemeId = this.themeConfiguration.colorTheme;

		this.logService.debug(`Attempting to find user's active theme:`, currentThemeId);
		let theme = this.colorThemeRegistry.findThemeBySettingsId(currentThemeId);

		if (!theme) {
			this.logService.debug(`User's active theme not found the registry. Was it mispelled or uninstalled?`);

			theme = ColorThemeData.createUnloadedThemeForThemeType(ColorScheme.LIGHT);
		}

		await theme.ensureLoaded(this.extensionResourceLoaderService);

		return theme;
	}
}
