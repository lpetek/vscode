/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Coder Technologies. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { setUnexpectedErrorHandler } from 'vs/base/common/errors';
import * as proxyAgent from 'vs/base/node/proxy_agent';
import { enableCustomMarketplace } from 'vs/server/marketplace';
import { ConsoleMainLogger } from 'vs/platform/log/common/log';
import { Server as WebSocketServer } from 'ws';
import { CodeServer, VscodeServerArgs as ServerArgs } from 'vs/server/server';
import { createServer, IncomingMessage } from 'http';
import * as net from 'net';

// eslint-disable-next-line code-import-patterns
import { requestHandler as defaultRequestHandler } from '../../../resources/web/code-web';

const logger = new ConsoleMainLogger();

setUnexpectedErrorHandler((error) => {
	logger.warn('Uncaught error', error instanceof Error ? error.message : error);
});

enableCustomMarketplace();
proxyAgent.monkeyPatch(true);

type UpgradeHandler = (request: IncomingMessage, socket: net.Socket, upgradeHead: Buffer) => void;

export async function main(args: ServerArgs) {
	const serverUrl = new URL(`http://${args.server}`);

	const codeServer = new CodeServer();
	const workbenchConstructionOptions = await codeServer.createWorkbenchConstructionOptions(serverUrl);

	const httpServer = createServer((req, res) => defaultRequestHandler(req, res, workbenchConstructionOptions));


	const wss = new WebSocketServer({
		noServer: true,
		perMessageDeflate: false,
	});

	logger.info(JSON.stringify(workbenchConstructionOptions.folderUri));
	wss.on('error', (error) => logger.error(error.message));

	const upgrade: UpgradeHandler = (request, socket, head) => {
		let query = new URLSearchParams();

		if (request.url) {
			// TODO use `socket.remoteAddress`
			const upgradeUrl = new URL(request.url, serverUrl.toString());
			logger.trace('Upgrade from', upgradeUrl.searchParams.toString());

			query = upgradeUrl.searchParams;
		}

		wss.handleUpgrade(request, socket, head, ws => {
			codeServer.handleWebSocket(ws, socket, query, !!wss.options.perMessageDeflate);
		});
	};

	httpServer.on('upgrade', upgrade);

	return new Promise((resolve, reject) => {
		httpServer.listen(parseInt(serverUrl.port, 10), serverUrl.hostname, () => {
			logger.info('Code Server active listening at:', serverUrl.toString());
		});
	});
}
