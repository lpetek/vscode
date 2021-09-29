/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as platform from 'vs/base/common/platform';
import { URI } from 'vs/base/common/uri';
import { Workspace } from 'vs/platform/workspace/common/workspace';
import { AbstractVariableResolverService } from 'vs/workbench/services/configurationResolver/common/variableResolver';
import { SimpleConfigProvider } from 'vs/workbench/api/common/extHostConfiguration';

/**
 * @see ExtHostVariableResolverService vs/workbench/api/common/extHostDebugService.ts
 */export class VariableResolverService extends AbstractVariableResolverService {
	constructor(
		private configProvider: SimpleConfigProvider,
		workspace: Workspace,
		activeFileResource: URI | undefined,
		env: platform.IProcessEnvironment,
	) {
		super({
			getFolderUri: (name: string): URI | undefined => {
				const folder = workspace.folders.find((f) => f.name === name);
				return folder && folder.uri;
			},
			getWorkspaceFolderCount: (): number => {
				return workspace.folders.length;
			},
			getConfigurationValue: (folderUri: URI, section: string): string | undefined => {
				return this.configProvider.getValue<string>(section, folderUri);
			},
			getAppRoot: (): string | undefined => {
				return env['VSCODE_CWD'] || process.cwd();
			},
			getExecPath: (): string | undefined => {
				return env['VSCODE_EXEC_PATH'];
			},
			/**
			 * @see AbstractVariableResolverService#evaluateSingleVariable vs/workbench/services/configurationResolver/common/variableResolver.ts
			 */
			getWorkspaceFolderPathForFile: (): string | undefined => {
				if (activeFileResource) {
					const folder = workspace.getFolder(activeFileResource);

					if (folder) {
						return path.normalize(folder.uri.fsPath);
					}
				}
				return undefined;
			},
			getFilePath: (): string | undefined => {
				if (activeFileResource) {
					return path.normalize(activeFileResource.fsPath);
				}
				return undefined;
			},

			/**
			 * @file vs/workbench/contrib/terminal/common/remoteTerminalChannel.ts
			 */
			getSelectedText: (): string | undefined => {
				return this.configProvider.getValue<string>('selectedText');
			},
			getLineNumber: (): string | undefined => {
				return this.configProvider.getValue<string>('lineNumber');
			},
		}, undefined, Promise.resolve(env));
	}
}
